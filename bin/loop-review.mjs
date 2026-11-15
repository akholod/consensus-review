#!/usr/bin/env node
// /loop-review runtime. Sequential, coverage-directed cyclic review over one immutable diff.
// Read-only with respect to reviewed source and external systems; see docs for the write surface.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { buildContext, resolveTarget, diffHash, parseScope } from "../src/loop-review/context.mjs"
import { runLoop } from "../src/loop-review/loop.mjs"
import { run as runClaude } from "../src/loop-review/adapter.mjs"
import { renderReport, summaryLine } from "../src/loop-review/report.mjs"
import { TERMINAL, evaluateTerminal } from "../src/loop-review/schema.mjs"
import { runId, canArchive, writeArchive } from "../scripts/lib/archive.mjs"
import { sameRepository, selectLenses } from "../scripts/lenses.mjs"
import { featureDiff, workTree, workspaceDiff } from "../scripts/lib/feature.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const argv = process.argv.slice(2)
// Accepts both `--name=value` and `--name value`; a bare `--name` is a boolean.
const flag = (name, fallback) => {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (i < 0) return fallback
  const hit = argv[i]
  if (hit.includes("=")) return hit.slice(hit.indexOf("=") + 1)
  const next = argv[i + 1]
  return next !== undefined && !next.startsWith("--") ? next : true
}

const repo = resolve(String(flag("repo", process.cwd())))
const model = String(flag("model", "sonnet"))
// A bad numeric flag must fail here with a clear message, not as ERR_OUT_OF_RANGE inside spawnSync.
const positiveNumber = (name, fallback) => {
  const raw = flag(name, fallback)
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    process.stderr.write(`--${name} must be a positive number (got ${JSON.stringify(raw)})\n`)
    process.exit(2)
  }
  return value
}
const timeoutMs = positiveNumber("timeout", 240) * 1000
const noFile = Boolean(flag("no-file", false))
const noArchive = Boolean(flag("no-archive", false))
const jsonOut = Boolean(flag("json", false))
const range = flag("range", null)
// Every --pr: two or more are one feature across repositories (feature mode).
const prTargets = argv.flatMap((a, i) => (a.startsWith("--pr=") ? [a.slice(5)] : a === "--pr" && argv[i + 1] && !argv[i + 1].startsWith("--") ? [argv[i + 1]] : []))
const prTarget = prTargets.length === 1 ? prTargets[0] : null
// A bare --pr (or --pr= with nothing) must not fall back to reviewing the working tree.
if (argv.some((a, i) => a === "--pr=" || (a === "--pr" && (!argv[i + 1] || argv[i + 1].startsWith("--"))))) {
  process.stderr.write("--pr needs a PR (a number, owner/repo#N or a URL)\n")
  process.exit(2)
}
const base = flag("base", null)
const outPath = flag("out", null)

const nonNegative = (name) => {
  const raw = flag(name, 0)
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    process.stderr.write(`--${name} must be a non-negative number (got ${JSON.stringify(raw)})\n`)
    process.exit(2)
  }
  return value
}

// A folder of repositories that is not one itself: its uncommitted changes are one feature (workspace mode).
const mode = prTargets.length > 1 ? "feature" : prTarget ? "pr" : range ? "range" : workTree(repo) ? "uncommitted" : "workspace"
const workDir = mkdtempSync(join(tmpdir(), "loop-review-"))

const log = (m) => process.stderr.write(`${m}\n`)

const targetArgs = { repo, mode, range: String(range ?? ""), prTarget: String(prTarget ?? ""), workDir, base: base === null ? null : String(base) }
// Workspace and feature diffs carry each repository's directory in their paths, relative to `root`;
// they have no single base, so no originals are read.
const resolveAny = () => {
  if (mode === "workspace") {
    const w = workspaceDiff(repo)
    return { diffText: w.diffText, base: null, root: w.root, describe: `workspace ${repo} (${w.changed.join(", ") || "no changes"})` }
  }
  if (mode === "feature") {
    const f = featureDiff({ invoke: repo, targets: prTargets, workDir, base: targetArgs.base })
    return { diffText: f.diffText, base: null, root: f.root, describe: `feature: ${f.prs.map((p) => `${p.target} → ${p.path}`).join(", ")}` }
  }
  return { ...resolveTarget(targetArgs), root: repo }
}
let resolved
try {
  resolved = resolveAny()
} catch (error) {
  if (mode !== "workspace" && mode !== "feature") throw error
  log(String(error?.message ?? error).split("\n")[0])
  process.exit(2)
}
if (!resolved.diffText.trim()) {
  log("No changes to review.")
  process.exit(0)
}

const ctx = buildContext({ repo: resolved.root, target: resolved.describe, diffText: resolved.diffText, base: resolved.base })
log(`target: ${ctx.target} | files: ${ctx.files.length} | cells: ${ctx.cells.length} | trivial: ${ctx.trivial} | high-risk: ${ctx.highRisk}`)

// Lenses go through the same checked path as /consensus-review, and only into the discovery
// prompt: the static prefix is the verifier's too. A PR from another repository (or a target whose
// repository cannot be told) reads no lenses from this checkout.
const scope = mode === "pr" ? parseScope(String(prTarget)) : null
const multi = mode === "workspace" || mode === "feature"
const lensRepo = multi ? null : mode !== "pr" || (scope?.pr && sameRepository(repo, scope)) ? repo : null
let lenses
try {
  lenses = selectLenses({ repo: lensRepo, diffText: resolved.diffText, mode: mode === "uncommitted" ? "uncommitted" : null, dims: ["architecture", "quality", "impact", "tests"] })
} catch (error) {
  log(String(error?.message ?? error).split("\n")[0])
  process.exit(2)
}
if (!lensRepo) lenses.plan.note = multi ? `repo lenses: not applied (${mode}: no single repository)` : "repo lenses: checkout is not the PR's repository"

const discovery = [readFileSync(join(ROOT, "prompts/loop-review/discovery.md"), "utf8"), lenses.texts.consultant].filter(Boolean).join("\n\n")
const verifyPrompt = readFileSync(join(ROOT, "prompts/loop-review/verify.md"), "utf8")

// Every call and every findings stage, kept in memory for the run archive (only when one can be
// written); nothing is written during the run.
const keep = !noFile && !noArchive
const calls = []
const stages = []
let lastPass = 0

const runner = async ({ prompt, systemPrefix, passIndex }) => {
  log(`pass ${passIndex}…`)
  lastPass = passIndex
  const startedAt = new Date().toISOString()
  const r = runClaude({ prompt, systemPrefix, model, timeoutMs, cwd: workDir })
  if (keep) calls.push({ kind: "pass", index: passIndex, startedAt, prompt, raw: r.raw, state: r.state, ms: r.ms })
  log(`  ${r.state} (${r.ms}ms, ${r.usage.input_tokens + r.usage.output_tokens} tok)`)
  return r
}

const verifier = async ({ findings, cells }) => {
  log(`verifying ${findings.length} finding(s), ${cells.length} high-risk cell(s)…`)
  // Same split as a discovery pass: the prefix is shared with every pass of this run, so it is
  // delivered out of band and the verification call reads it from cache instead of re-sending it.
  const prompt = [
    verifyPrompt,
    `<findings>\n${JSON.stringify(findings, null, 2)}\n</findings>`,
    `<cells_to_verify>\n${JSON.stringify(cells, null, 2)}\n</cells_to_verify>`,
  ].join("\n\n")
  const startedAt = new Date().toISOString()
  const r = runClaude({ prompt, systemPrefix: ctx.staticPrefix, model, timeoutMs, cwd: workDir, requireKey: "verdicts" })
  if (keep) calls.push({ kind: "verify", index: lastPass, startedAt, prompt, raw: r.raw, state: r.state, ms: r.ms })
  if (r.state !== "ok") {
    log(`  verifier ${r.state} — nothing adjudicated`)
    // Usage is still spent even when the call is unusable, so it is still charged to the budget.
    return { verdicts: [], cell_verdicts: [], usage: r.usage, ms: r.ms, state: r.state, modelId: r.modelId, runnerId: r.runnerId }
  }
  return {
    verdicts: r.payload?.verdicts ?? [],
    cell_verdicts: r.payload?.cell_verdicts ?? [],
    usage: r.usage,
    ms: r.ms,
    state: r.state,
    modelId: r.modelId,
    runnerId: r.runnerId,
  }
}

const run = await runLoop({
  ctx,
  runner,
  verifier,
  discoveryInstructions: discovery,
  budget: {
    tokens: nonNegative("max-tokens"),
    calls: nonNegative("max-calls"),
    ms: nonNegative("max-ms"),
  },
  onStage: keep ? (s) => stages.push(s) : undefined,
})

// Sample the target again now that all model work is done: a tree that moved during the review
// makes the run stale, and a stale run is never CLEAN.
// A source that fails now (gh or the network) leaves the run unverifiable: stale, never CLEAN, but
// the report is still written.
let finalHash
try {
  finalHash = diffHash(resolveAny().diffText)
} catch (error) {
  log(`re-sampling the diff failed: ${String(error?.message ?? error).split("\n")[0]}`)
  finalHash = "unavailable"
}
if (finalHash !== ctx.diffHash) log(`diff changed during the run (${ctx.diffHash} -> ${finalHash})`)
const terminal = evaluateTerminal(run, finalHash)
run.terminal = terminal.state
run.terminalReasons = terminal.reasons

const reportFile = outPath ? resolve(String(outPath)) : join(repo, ".reviews", `loop-review-${ctx.diffHash}.md`)

// The archive is written before the report is rendered, so the report can say where it went.
const archiveRun = () => {
  if (noFile) return { skipped: "--no-file" }
  if (noArchive) return { skipped: "--no-archive" }
  const id = runId(reportFile)
  const where = canArchive(repo, id)
  if (!where.ok) return { skipped: where.reason }
  const at = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString()
  const now = new Date().toISOString()
  const events = [
    ...calls.flatMap((c) => [
      { ts: c.startedAt, type: `${c.kind}.start`, index: c.index },
      { ts: at(c.startedAt, c.ms), type: `${c.kind}.finish`, index: c.index, state: c.state, status: c.raw.status, signal: c.raw.signal, error: c.raw.error?.code ?? null },
    ]),
    ...run.rejections.map((detail) => ({ ts: now, type: "rejection", detail })),
    ...run.escalations.map((detail) => ({ ts: now, type: "escalation", detail })),
    { ts: now, type: "terminal", state: run.terminal, reasons: run.terminalReasons },
  ]
  const src = (c) => `sources/${c.kind}-${c.index}`
  const json = (v) => `${JSON.stringify(v, null, 2)}\n`
  // Cap priority: events, process records, findings, prompts, system prefix, raw outputs.
  const entries = [
    { to: "events.jsonl", content: events.map((e) => JSON.stringify(e)).join("\n") + "\n" },
    ...calls.map((c) => ({ to: `${src(c)}/process.json`, content: json({ status: c.raw.status, signal: c.raw.signal, error: c.raw.error, ms: c.ms, state: c.state }) })),
    ...stages.map((s) => ({ to: `findings/${s.stage}-${s.index}.json`, content: json(s.findings) })),
    { to: "findings/final.json", content: json(run.findings) },
    ...calls.map((c) => ({ to: `${src(c)}/prompt.md`, content: c.prompt })),
    { to: "sources/context/system-prefix.md", content: ctx.staticPrefix },
    ...(lenses.texts.consultant ? [{ to: "sources/context/lenses.md", content: lenses.texts.consultant }] : []),
    ...calls.flatMap((c) => [
      { to: `${src(c)}/stdout.json`, content: c.raw.stdout },
      { to: `${src(c)}/stderr.txt`, content: c.raw.stderr },
    ]),
  ]
  const meta = { createdAt: now, command: "loop-review", target: ctx.target, mode, diffHash: ctx.diffHash, flags: argv, report: reportFile, terminal: run.terminal }
  const r = writeArchive({ dir: where.dir, runId: id, entries, meta, diff: resolved.diffText, repoTop: where.top })
  return r.ok ? { dir: r.dir } : { skipped: r.reason }
}
const archive = archiveRun()
log(archive.dir ? `archive: ${archive.dir}` : `archive: not written (${archive.skipped})`)

const report = renderReport(run, { target: ctx.target, archive: archive.dir ? { dir: relative(repo, archive.dir) } : archive, lenses: lenses.plan, pr: mode === "pr" })

if (jsonOut) {
  process.stdout.write(JSON.stringify({ terminal: run.terminal, reasons: run.terminalReasons, findings: run.findings, cells: run.cells, passes: run.passes, spent: run.spent, lenses: lenses.plan, archive }, null, 2) + "\n")
} else {
  process.stdout.write(report + "\n")
}

if (!noFile) {
  mkdirSync(dirname(reportFile), { recursive: true })
  writeFileSync(reportFile, report)
  log(`report: ${reportFile}`)
} else {
  log("report: not written (--no-file)")
}

log(summaryLine(run))
process.exit(run.terminal === TERMINAL.ESCALATE ? 2 : 0)
