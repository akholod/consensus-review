#!/usr/bin/env node
// Copies a /consensus-review work dir into the invoking repo's run archive, once, at the end of the
// run (or by hand, to salvage a run that died). Every write goes through writeArchive in
// scripts/lib/archive.mjs; this file only reads $WD and decides what goes where.
//
//   finish --wd <dir> [--report <final report path>] [--off]
//
// Run settings come from $WD/settings.json (scripts/settings.mjs) and the mode from $WD/triage.json;
// either may be absent (a salvaged run), and the meta fields they feed are then null.
//
// Prints one JSON line, `{"dir":…}` or `{"skipped":…}`, and exits 0 either way: a missing archive
// never fails the review. A usage error exits 2.
//
// `sources/<lane>/prompt.md` is the lane's brief only. When the lane's status.json names a lens file
// (`lenses`), the prompt the lane actually got is that brief + "\n\n" + `sources/lenses/<status.lenses>`.

import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { canArchive, deriveEvents, runId, writeArchive } from "./lib/archive.mjs"
import { BRIEFS, fallbackVerdicts } from "./lib/lanes.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const OPTIONS = { wd: { type: "string" }, report: { type: "string" }, off: { type: "boolean" } }
const USAGE = "usage: archive-run.mjs finish --wd <dir> [--report <path>] [--off]"
const REFUTER = /-refuter$/
const AGENTS = { architecture: "arch-reviewer", quality: "quality-reviewer", impact: "impact-reviewer", tests: "test-reviewer" }
const UNAVAILABLE = "host does not expose the Task prompt/transcript"

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

class UsageError extends Error {}

/**
 * synthesis.json joined by id with the final verdict: from sceptic.decision.json (mode from its
 * voteMode), or, when there is no usable decision, the single safe fallback over
 * verifier.verdicts.json (mode `fallback`; a missing verifier file leaves every P0/P1 `unconfirmed`). A join over ids that do not line up is refused: `{ reason }`.
 */
function verification({ synthesis, sceptic, verdicts, ids, scepticOff }) {
  if (!Array.isArray(synthesis?.findings)) return { reason: "no synthesis.json" }
  const raw = synthesis.findings.map((f) => f?.id)
  const invalid = raw.filter((id) => typeof id !== "string" || !id)
  if (invalid.length) return { reason: `invalid ids in synthesis.json: ${invalid.map((id) => JSON.stringify(id ?? null)).join(", ")}` }
  const dupes = [...new Set(raw.filter((id, i) => raw.indexOf(id) !== i))]
  if (dupes.length) return { reason: `duplicate ids in synthesis.json: ${dupes.join(", ")}` }
  const known = new Set(synthesis.findings.map((f) => f.id))
  const decided = sceptic && !sceptic.error && sceptic.perFinding && typeof sceptic.perFinding === "object"
  if (!decided && scepticOff) return { reason: "the sceptic did not run" }
  const byId = decided
    ? new Map(Object.entries(sceptic.perFinding).map(([id, p]) => [id, { verdict: p.decision, voters: p.voters }]))
    : new Map(Object.entries(fallbackVerdicts(synthesis.findings, verdicts)).map(([id, verdict]) => [id, { verdict }]))
  const unknown = [...(decided && Array.isArray(ids) ? ids : []), ...byId.keys()].filter((id) => !known.has(id))
  if (unknown.length) return { reason: `ids not in synthesis.json: ${[...new Set(unknown)].join(", ")}` }
  const mode = !decided ? "fallback" : sceptic.voteMode === "basic" ? "basic" : "strict"
  const findings = synthesis.findings.map((f) => ({ ...f, ...(byId.get(f.id) ?? { verdict: null }) }))
  return { value: { mode, findings } }
}

function finish(v) {
  if (!v.wd) throw new UsageError("--wd is required")
  const wd = resolve(v.wd)
  if (!existsSync(wd) || !statSync(wd).isDirectory()) throw new UsageError(`--wd is not a directory: ${v.wd}`)
  if (v.off) return { skipped: "archive=off" }

  const now = new Date()
  const id = v.report ? runId(v.report, now) : runId(`salvage-${basename(wd)}`, now)
  const can = canArchive(process.cwd(), id)
  if (!can.ok) return { skipped: can.reason }

  const at = (name) => join(wd, name)
  const has = (name) => existsSync(at(name))
  const mtime = (name) => statSync(at(name)).mtime.toISOString()
  const files = readdirSync(wd)

  const statuses = {}
  for (const name of files.filter((f) => f.endsWith(".status.json")).map((f) => f.slice(0, -".status.json".length)).sort()) {
    const s = readJson(at(`${name}.status.json`))
    if (s && typeof s === "object") statuses[name] = s
  }
  const names = Object.keys(statuses)
  const prompt = (name) => (statuses[name].brief && basename(String(statuses[name].brief))) ??
    BRIEFS[statuses[name].kind ?? name.replace(REFUTER, "")]?.[REFUTER.test(name) ? 1 : 0]
  const decisions = {}
  for (const phase of ["review", "sceptic"]) {
    const d = readJson(at(`${phase}.decision.json`))
    if (d && typeof d === "object") decisions[phase] = { ...d, ts: mtime(`${phase}.decision.json`) }
  }
  const settings = readJson(at("settings.json"))
  const triage = readJson(at("triage.json"))
  const claude = readJson(at("claude-findings.json"))
  const synthesis = readJson(at("synthesis.json"))
  const verdicts = readJson(at("verifier.verdicts.json"))
  const ids = readJson(at("ids.json"))

  const notWritten = {}
  const panel = []
  const sources = [...names.filter((name) => !REFUTER.test(name)).map((name) => [name, `${name}.json`]), ["claude", "claude-findings.json"]]
  for (const [source, file] of sources) {
    const findings = readJson(at(file))?.findings
    if (Array.isArray(findings)) panel.push(...findings.map((f) => ({ ...f, source })))
  }
  const sceptic = settings?.settings?.sceptic?.value ?? "strict"
  const joined = verification({ synthesis, sceptic: decisions.sceptic, verdicts, ids, scepticOff: sceptic === "off" })
  if (joined.reason) notWritten["findings/verification.json"] = joined.reason

  const json = (value) => `${JSON.stringify(value, null, 2)}\n`
  const events = deriveEvents({ statuses, decisions, triage: triage && { ...triage, ts: mtime("triage.json") } })
  // Order is the cap priority: events, statuses/decisions, findings, lens files (small; a prompt is
  // incomplete without its lens), prompts, the command, outputs, logs.
  const entries = [{ to: "events.jsonl", content: events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "") }]
  const copy = (from, to) => has(from) && entries.push({ to, from: at(from) })
  for (const name of names) copy(`${name}.status.json`, `sources/${name}/status.json`)
  for (const name of ["settings.json", "consultants.json", "lenses.json", "ids.json", "review.decision.json", "sceptic.decision.json"]) copy(name, `decisions/${name}`)
  entries.push({ to: "findings/panel.json", content: json({ findings: panel }) })
  if (joined.value) entries.push({ to: "findings/verification.json", content: json(joined.value) })
  copy("synthesis.json", "findings/synthesis.json")
  copy("claude-findings.json", "findings/claude.json")
  copy("verifier.verdicts.json", "sources/finding-verifier/output.json")
  for (const file of files.filter((f) => /^lenses-.+\.md$/.test(f)).sort()) copy(file, `sources/lenses/${file}`)
  for (const name of names) if (prompt(name)) copy(prompt(name), `sources/${name}/prompt.md`)
  entries.push({ to: "sources/arbiter/command.md", from: join(ROOT, "commands/consensus-review.md") })
  const attempts = (name, ext) => files
    .map((f) => f.match(new RegExp(`^${name}\\.a(\\d+)\\.${ext}$`)))
    .filter(Boolean)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
  for (const name of names) for (const m of attempts(name, "json")) copy(m[0], `sources/${name}/output-a${m[1]}.json`)
  for (const name of names) for (const m of attempts(name, "log")) copy(m[0], `sources/${name}/attempt-${m[1]}.log`)

  const transcribed = [
    ["synthesis.json", "findings/synthesis.json"], ["claude-findings.json", "findings/claude.json"],
    ["verifier.verdicts.json", "sources/finding-verifier/output.json"], ["triage.json", "events.jsonl:triage"],
  ].filter(([from]) => has(from)).map(([, to]) => to)

  const dims = Array.isArray(triage?.dims) ? triage.dims : (claude?.findings ?? []).map((f) => f?.dimension)
  const agents = [...new Set(dims.map((d) => AGENTS[d]).filter(Boolean))]
  if (has("verifier.verdicts.json") || decisions.sceptic) agents.push("finding-verifier")
  const unavailable = agents.map((source) => ({ source, reason: UNAVAILABLE }))

  const p0p1 = (synthesis?.findings ?? []).some((f) => f?.severity === "P0" || f?.severity === "P1")
  // Every lane's prompt, deduplicated; a refuter's brief is written only for a refuter marked `run`.
  const briefed = names.filter((name) => !(REFUTER.test(name) && ["skipped", "unavailable"].includes(statuses[name].status)))
  const expected = [...new Set(briefed.map(prompt).filter(Boolean)), "diff.patch", "triage.json", "claude-findings.json", "synthesis.json"]
  if (sceptic !== "off" && p0p1) expected.push("ids.json", "verifier.verdicts.json")

  const diff = has("diff.patch") ? readFileSync(at("diff.patch")) : null
  const lanes = Object.fromEntries(Object.entries(statuses).map(([name, s]) =>
    [name, { status: s.status ?? null, display: s.display ?? null, model: s.model ?? null, provider: s.provider ?? null, schema: s.schema ?? null }]))
  const meta = {
    createdAt: now.toISOString(),
    command: "consensus-review",
    target: !settings ? null : settings.target?.kind === "pr" ? settings.target.ref : "uncommitted",
    mode: triage?.mode ?? null,
    pluginVersion: readJson(join(ROOT, ".claude-plugin/plugin.json"))?.version ?? null,
    report: v.report ? resolve(v.report) : null,
    workDir: wd,
    settings,
    diffHash: diff ? createHash("sha256").update(diff).digest("hex").slice(0, 16) : null,
    lanes,
    missing: expected.filter((name) => !has(name)),
    transcribed,
    unavailable,
    notWritten,
  }
  const res = writeArchive({ dir: can.dir, runId: id, entries, meta, diff, repoTop: can.top })
  return res.ok ? { dir: res.dir } : { skipped: res.reason }
}

export function main(argv) {
  let out
  try {
    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true })
    if (positionals[0] !== "finish" || positionals.length !== 1) throw new UsageError(USAGE)
    out = finish(values)
  } catch (err) {
    if (err instanceof UsageError || err.code?.startsWith("ERR_PARSE_ARGS")) {
      process.stderr.write(`${err.message}\n${err.message === USAGE ? "" : `${USAGE}\n`}`)
      return 2
    }
    out = { skipped: err.message }
  }
  process.stdout.write(`${JSON.stringify(out)}\n`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
