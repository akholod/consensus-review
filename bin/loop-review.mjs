#!/usr/bin/env node
// /loop-review runtime. Sequential, coverage-directed cyclic review over one immutable diff.
// Read-only with respect to reviewed source and external systems; see docs for the write surface.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { buildContext, resolveTarget, diffHash } from "../src/loop-review/context.mjs"
import { runLoop } from "../src/loop-review/loop.mjs"
import { run as runClaude } from "../src/loop-review/adapter.mjs"
import { renderReport, summaryLine } from "../src/loop-review/report.mjs"
import { TERMINAL, evaluateTerminal } from "../src/loop-review/schema.mjs"

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
const jsonOut = Boolean(flag("json", false))
const range = flag("range", null)
const prTarget = flag("pr", null)
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

const mode = prTarget ? "pr" : range ? "range" : "uncommitted"
const workDir = mkdtempSync(join(tmpdir(), "loop-review-"))

const log = (m) => process.stderr.write(`${m}\n`)

const resolved = resolveTarget({ repo, mode, range: String(range ?? ""), prTarget: String(prTarget ?? ""), workDir })
if (!resolved.diffText.trim()) {
  log("No changes to review.")
  process.exit(0)
}

const ctx = buildContext({ repo, target: resolved.describe, diffText: resolved.diffText, base: resolved.base })
log(`target: ${ctx.target} | files: ${ctx.files.length} | cells: ${ctx.cells.length} | trivial: ${ctx.trivial} | high-risk: ${ctx.highRisk}`)

const discovery = readFileSync(join(ROOT, "prompts/loop-review/discovery.md"), "utf8")
const verifyPrompt = readFileSync(join(ROOT, "prompts/loop-review/verify.md"), "utf8")

const runner = async ({ prompt, passIndex }) => {
  log(`pass ${passIndex}…`)
  const r = runClaude({ prompt, model, timeoutMs, cwd: workDir })
  log(`  ${r.state} (${r.ms}ms, ${r.usage.input_tokens + r.usage.output_tokens} tok)`)
  return r
}

const verifier = async ({ findings, cells }) => {
  log(`verifying ${findings.length} finding(s), ${cells.length} high-risk cell(s)…`)
  const prompt = [
    ctx.staticPrefix,
    verifyPrompt,
    `<findings>\n${JSON.stringify(findings, null, 2)}\n</findings>`,
    `<cells_to_verify>\n${JSON.stringify(cells, null, 2)}\n</cells_to_verify>`,
  ].join("\n\n")
  const r = runClaude({ prompt, model, timeoutMs, cwd: workDir, requireKey: "verdicts" })
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
})

// Sample the target again now that all model work is done: a tree that moved during the review
// makes the run stale, and a stale run is never CLEAN.
const finalDiff = resolveTarget({ repo, mode, range: String(range ?? ""), prTarget: String(prTarget ?? ""), workDir })
const finalHash = diffHash(finalDiff.diffText)
if (finalHash !== ctx.diffHash) log(`diff changed during the run (${ctx.diffHash} -> ${finalHash})`)
const terminal = evaluateTerminal(run, finalHash)
run.terminal = terminal.state
run.terminalReasons = terminal.reasons

const report = renderReport(run, { target: ctx.target })

if (jsonOut) {
  process.stdout.write(JSON.stringify({ terminal: run.terminal, reasons: run.terminalReasons, findings: run.findings, cells: run.cells, passes: run.passes, spent: run.spent }, null, 2) + "\n")
} else {
  process.stdout.write(report + "\n")
}

if (!noFile) {
  const dir = outPath ? dirname(resolve(String(outPath))) : join(repo, ".reviews")
  mkdirSync(dir, { recursive: true })
  const file = outPath ? resolve(String(outPath)) : join(dir, `loop-review-${ctx.diffHash}.md`)
  writeFileSync(file, report)
  log(`report: ${file}`)
} else {
  log("report: not written (--no-file)")
}

log(summaryLine(run))
process.exit(run.terminal === TERMINAL.ESCALATE ? 2 : 0)
