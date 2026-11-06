#!/usr/bin/env node
// Picks the external review lanes, runs one of them (codex, pi or claude-cli) under the retry-once
// policy, and folds the lanes' statuses into a decision. Every decision is in scripts/lib/lanes.mjs; this file owns only the
// processes and the files, all of which live under --wd (never in the reviewed repository).
//
//   select [--wd <dir>] [--consultant <codex|pi|claude-cli>] [--extra] [--pi-model <m>]
//   run <codex|pi|claude-cli> --wd <dir> --name <name> --repo <dir> --brief-file <file> --timeout <sec>
//       [--schema <file>] [--model <m>] [--require-key findings|verdicts] [--ids-file <file>]
//       [--skip <why> [--skip-reason <r>]] [--from-decision <file>] [--kill-grace <sec>] [--lenses-file <file>]
//   decide --wd <dir> --phase review|sceptic --lanes <name,name> [--ids-file <file>, default <wd>/ids.json]
//       [--repo <dir>] [--diff <file>, default <wd>/diff.patch] [--head-sha <worktree|40-hex>]   (sceptic only)
//
// Each attempt runs in its own process group, which is killed whenever the attempt settles, so a
// grandchild never outlives its attempt. A killed helper writes no status; `decide` reports that.

import { spawn, spawnSync } from "node:child_process"
import { closeSync, existsSync, linkSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { constants } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import {
  CLAUDE_CLI_MODEL, classifyClaudeResult, classifyCodexResult, classifyPiResult, decideRetry, decideReview,
  decideSceptic, helperError, killGrace, laneCommand, laneStatus, parseVotes,
  selectConsultants, validIds, validRefuterEntry, validStatus,
} from "./lib/lanes.mjs"
import { listPiModels } from "./lib/probe.mjs"
import { makeVerifyCitation } from "./lib/quote-check.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const OPTIONS = {
  ...Object.fromEntries(
    ["wd", "name", "repo", "brief-file", "timeout", "schema", "model", "require-key", "ids-file", "skip", "skip-reason",
      "from-decision", "kill-grace", "lenses-file", "phase", "lanes", "consultant", "pi-model", "diff", "head-sha"].map((k) => [k, { type: "string" }]),
  ),
  extra: { type: "boolean" },
}

/** Each lane's classifier; `text` is the attempt's mixed stdout/stderr log. */
const CLASSIFY = {
  codex: ({ text, ...a }) => classifyCodexResult({ ...a, log: text }),
  pi: ({ text, ...a }) => classifyPiResult({ ...a, out: text }),
  "claude-cli": ({ text, ...a }) => classifyClaudeResult({ ...a, out: text }),
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

/**
 * tmp + rename: a reader (the arbiter's poll, `decide`) never sees a half-written file. With
 * `once`, tmp + link instead: the first writer wins and false means the file already existed.
 */
function writeAtomic(path, value, { once = false } = {}) {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`)
  if (!once) return renameSync(tmp, path), true
  try {
    linkSync(tmp, path)
    return true
  } catch (err) {
    if (err.code === "EEXIST") return false
    throw err
  } finally {
    unlinkSync(tmp)
  }
}

const killGroup = (pid, signal) => {
  try {
    process.kill(-pid, signal)
  } catch {
    // ESRCH: the group is already gone
  }
}

let active = null // the attempt's group leader, killed on any helper exit

function attempt({ lane, wd, file, cmd, seconds, grace, requireKey, onSpawned }) {
  const started = performance.now()
  const log = openSync(join(wd, `${file}.log`), "w")
  const child = spawn(cmd.bin, cmd.args, { cwd: cmd.cwd, env: cmd.env, detached: true, stdio: ["ignore", log, log] })
  active = child
  onSpawned?.(child)
  let timedOut = false
  let killTimer
  const termTimer = setTimeout(() => {
    timedOut = true
    killGroup(child.pid, "SIGTERM")
    killTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), grace * 1000)
  }, seconds * 1000)
  return new Promise((resolve) => {
    let settled = false
    const settle = (rc, spawnError) => {
      if (settled) return
      settled = true
      clearTimeout(termTimer)
      clearTimeout(killTimer)
      if (child.pid) killGroup(child.pid, "SIGKILL") // settle = group dead, even after a clean exit
      active = null
      closeSync(log)
      const text = spawnError ?? readFileSync(join(wd, `${file}.log`), "utf8")
      const result = CLASSIFY[lane]({ rc, timedOut, text, outPath: join(wd, `${file}.json`), requireKey })
      resolve({ ...result, rc, seconds: Number(((performance.now() - started) / 1000).toFixed(2)) })
    }
    child.once("error", (err) => settle(err.code === "ENOENT" ? 127 : 126, `${err.message}\n`))
    child.once("exit", (code, signal) => settle(code ?? 128 + (constants.signals[signal] ?? 0)))
  })
}

async function runLane(lane, v, { onSpawned }) {
  const wd = v.wd
  const name = v.name ?? lane
  // Every status records its own facts, so the decision files and the archive need no per-lane code.
  const facts = { lane: name, kind: lane, brief: v["brief-file"] ? basename(v["brief-file"]) : null, requestedModel: v.model ?? null, lenses: null }
  const finish = (s) => (writeAtomic(join(wd, `${name}.status.json`), { ...s, ...facts }), 0)

  if (v.skip) {
    return finish(v.skip === "unavailable"
      ? { status: "unavailable", display: v["skip-reason"] ? `unavailable (${v["skip-reason"]})` : "unavailable", attempts: [] }
      : { status: "skipped", display: `skipped (${v.skip})`, attempts: [] })
  }
  if (v["from-decision"]) {
    const entry = readJson(v["from-decision"])?.refuters?.[name]
    if (!validRefuterEntry(entry)) return finish(helperError(name, "no review decision"))
    if (entry !== "run") return finish({ status: "skipped", display: entry, attempts: [] })
  }

  const requireKey = v["require-key"] ?? "findings"
  // A verdict run without the sent ids cannot tell a real vote from an invented one: fail closed.
  const ids = requireKey === "verdicts" ? validIds(v["ids-file"] ? readJson(v["ids-file"]) : null) : null
  if (requireKey === "verdicts" && !ids) return finish(helperError(name, "no ids"))

  const T = Number(v.timeout)
  if (!(T > 0)) throw new Error(`--timeout must be a positive number of seconds (got ${JSON.stringify(v.timeout)})`)
  const grace = killGrace(T, v["kill-grace"] == null ? null : Number(v["kill-grace"]))
  const schema = v.schema ?? join(ROOT, "contracts", requireKey === "verdicts" ? "verdict.schema.json" : "finding.schema.json")
  let brief = readFileSync(v["brief-file"], "utf8")
  // Project lenses are advisory: an unreadable file runs the lane without them (status says "missing").
  if (v["lenses-file"]) {
    try {
      brief = `${brief}\n\n${readFileSync(v["lenses-file"], "utf8")}`
      facts.lenses = basename(v["lenses-file"])
    } catch {
      facts.lenses = "missing"
    }
  }
  const start = performance.now()
  const attempts = []
  let result
  for (let n = 1, seconds = T; n <= 2; n++) {
    const file = `${name}.a${n}`
    const cmd = laneCommand(lane, { repo: v.repo, wd, schema, out: join(wd, `${file}.json`), model: v.model, brief })
    const startedAt = new Date().toISOString()
    result = await attempt({ lane, wd, file, cmd, seconds, grace, requireKey, onSpawned })
    const record = { n, startedAt, status: result.status, reason: result.reason ?? null, rc: result.rc, seconds: result.seconds }
    if (result.status === "ok" && ids) {
      const { status, ignored, duplicates } = parseVotes(result.payload, ids)
      Object.assign(record, { ignored, duplicates })
      if (status !== "ok") {
        result = { ...result, status: "unparseable", reason: "no valid verdict for any sent id" }
        Object.assign(record, { status: result.status, reason: result.reason })
      }
    }
    attempts.push(record)
    if (result.status === "ok") break
    const next = decideRetry({ T, g: grace, elapsed: (performance.now() - start) / 1000, status: result.status })
    if (n === 2 || !next.retry) break
    seconds = next.t2
  }

  // The canonical output exists only for a usable result, so its absence can never read as "0 findings".
  if (result.status === "ok") writeAtomic(join(wd, `${name}.json`), result.payload)
  const meta = lane === "pi"
    ? { model: result.model ?? null, provider: result.provider ?? null }
    : lane === "claude-cli"
      ? { model: result.model ?? v.model ?? CLAUDE_CLI_MODEL, schema }
      : { model: v.model ?? null, schema }
  return finish({ ...laneStatus(attempts), attempts, ...meta })
}

/** Present = `<bin> --version` exits 0. Presence only: a broken login still counts as installed. */
const installed = (bin) => spawnSync(bin, ["--version"], { stdio: "ignore", timeout: 10_000 }).status === 0

/** §2 gate: a pending profile, or a settings.json that cannot be read, stops before any review work. */
const settingsGate = (wd) => {
  const path = join(wd, "settings.json")
  if (!existsSync(path)) return null
  let settings = null
  try {
    settings = JSON.parse(readFileSync(path, "utf8"))
  } catch {}
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return "settings.json unreadable"
  if (settings.profile?.pending) return `profile ${settings.profile.name} was not applied (run settings.mjs profile first)`
  return null
}

function select(v) {
  const blocked = v.wd ? settingsGate(v.wd) : null
  if (blocked) {
    process.stderr.write(`${blocked}\n`)
    return 2
  }
  const has = { codex: installed("codex"), pi: installed("pi"), claude: installed("claude") }
  const forced = v.consultant && v.consultant !== "auto" ? v.consultant : null
  const pinned = v["pi-model"] && v["pi-model"] !== "auto"
  // The catalog is read only when pi may run and no model is pinned.
  const needed = has.pi && !pinned && (forced === "pi" || (!forced && !has.codex) || v.extra)
  let out
  try {
    out = selectConsultants({
      installed: has, consultant: v.consultant, extra: Boolean(v.extra), piModel: v["pi-model"],
      piModels: needed ? listPiModels() : null,
    })
  } catch (err) {
    process.stderr.write(`${err.message}\n`)
    return 2
  }
  const wd = v.wd
  if (wd) writeAtomic(join(wd, "consultants.json"), out)
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
  return 0
}

/** Citation check for the sceptic tally; clone reads only per --repo/--head-sha, never without both. */
export function buildVerifyCitation(v) {
  let diffText = ""
  try {
    diffText = readFileSync(v.diff ?? join(v.wd, "diff.patch"), "utf8")
  } catch {}
  return makeVerifyCitation({ diffText, repo: v.repo, headSha: v["head-sha"] })
}

function decide(v) {
  const wd = v.wd
  const lanes = {}
  for (const name of (v.lanes ?? "").split(",").filter(Boolean)) {
    const s = readJson(join(wd, `${name}.status.json`))
    lanes[name] = validStatus(s, name) ? s : helperError(name, "no status written")
  }
  if (v.phase === "review") {
    // Write-once: the background call's decide and the arbiter's fallback decide may both run.
    if (!writeAtomic(join(wd, "review.decision.json"), decideReview(lanes), { once: true })) {
      process.stderr.write("review.decision.json already exists; kept the first decision\n")
    }
  }
  else if (v.phase === "sceptic") {
    const payloads = Object.fromEntries(Object.keys(lanes).map((name) =>
      [name, lanes[name].status === "ok" ? readJson(join(wd, `${name}.json`)) : null]))
    const verifierPath = join(wd, "verifier.verdicts.json")
    const verifier = existsSync(verifierPath) ? readJson(verifierPath) : undefined
    const ids = readJson(v["ids-file"] ?? join(wd, "ids.json"))
    writeAtomic(join(wd, "sceptic.decision.json"), decideSceptic(lanes, ids, verifier, payloads,
      { verifyCitation: buildVerifyCitation(v) }))
  } else throw new Error(`--phase must be review or sceptic (got ${JSON.stringify(v.phase)})`)
  return 0
}

export async function main(argv, hooks = {}) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true })
  if (positionals[0] === "select") return select(values)
  if (!values.wd) throw new Error("--wd is required")
  if (positionals[0] === "decide") return decide(values)
  if (positionals[0] !== "run") throw new Error("usage: run-lane.mjs select … | run <codex|pi|claude-cli> … | decide …")
  // No orphans: whatever ends the helper also ends the active attempt's group. No status is written.
  process.on("exit", () => active && killGroup(active.pid, "SIGKILL"))
  process.on("SIGTERM", () => process.exit(143))
  process.on("SIGINT", () => process.exit(130))
  return runLane(positionals[1], values, hooks)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
