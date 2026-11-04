#!/usr/bin/env node
// Runs one external review lane (codex or pi) under the retry-once policy, and folds the lanes'
// statuses into a decision. Every decision is in scripts/lib/lanes.mjs; this file owns only the
// processes and the files, all of which live under --wd (never in the reviewed repository).
//
//   run <codex|pi> --wd <dir> --name <name> --repo <dir> --brief-file <file> --timeout <sec>
//       [--schema <file>] [--model <m>] [--require-key findings|verdicts] [--ids-file <file>]
//       [--skip <why>] [--from-decision <file>] [--kill-grace <sec>]
//   decide --wd <dir> --phase review|sceptic --lanes <name,name> [--ids-file <file>, default <wd>/ids.json]
//
// Each attempt runs in its own process group, which is killed whenever the attempt settles, so a
// grandchild never outlives its attempt. A killed helper writes no status; `decide` reports that.

import { spawn } from "node:child_process"
import { closeSync, existsSync, linkSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { constants } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import {
  classifyCodexResult, classifyPiResult, decideRetry, decideReview, decideSceptic, helperError,
  killGrace, laneCommand, laneStatus, parseVerdicts, validIds, validRefuterEntry, validStatus,
} from "./lib/lanes.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const OPTIONS = Object.fromEntries(
  ["wd", "name", "repo", "brief-file", "timeout", "schema", "model", "require-key", "ids-file", "skip",
    "from-decision", "kill-grace", "phase", "lanes"].map((k) => [k, { type: "string" }]),
)

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
  const child = spawn(cmd.bin, cmd.args, { cwd: cmd.cwd, detached: true, stdio: ["ignore", log, log] })
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
      const outPath = join(wd, `${file}.json`)
      const result = lane === "codex"
        ? classifyCodexResult({ rc, timedOut, log: text, outPath, requireKey })
        : classifyPiResult({ rc, timedOut, out: text, requireKey })
      resolve({ ...result, rc, seconds: Number(((performance.now() - started) / 1000).toFixed(2)) })
    }
    child.once("error", (err) => settle(err.code === "ENOENT" ? 127 : 126, `${err.message}\n`))
    child.once("exit", (code, signal) => settle(code ?? 128 + (constants.signals[signal] ?? 0)))
  })
}

async function runLane(lane, v, { onSpawned }) {
  const wd = v.wd
  const name = v.name ?? lane
  const finish = (s) => (writeAtomic(join(wd, `${name}.status.json`), { lane: name, ...s }), 0)

  if (v.skip) {
    return finish(v.skip === "unavailable"
      ? { status: "unavailable", display: "unavailable", attempts: [] }
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
  const brief = readFileSync(v["brief-file"], "utf8")
  const start = performance.now()
  const attempts = []
  let result
  for (let n = 1, seconds = T; n <= 2; n++) {
    const file = `${name}.a${n}`
    const cmd = laneCommand(lane, { repo: v.repo, schema, out: join(wd, `${file}.json`), model: v.model, brief })
    const startedAt = new Date().toISOString()
    result = await attempt({ lane, wd, file, cmd, seconds, grace, requireKey, onSpawned })
    const record = { n, startedAt, status: result.status, reason: result.reason ?? null, rc: result.rc, seconds: result.seconds }
    if (result.status === "ok" && ids) {
      const { status, ignored, duplicates } = parseVerdicts(result.payload, ids)
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
    : { model: v.model ?? null, schema }
  return finish({ ...laneStatus(attempts), attempts, ...meta })
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
    writeAtomic(join(wd, "sceptic.decision.json"), decideSceptic(lanes, ids, verifier, payloads))
  } else throw new Error(`--phase must be review or sceptic (got ${JSON.stringify(v.phase)})`)
  return 0
}

export async function main(argv, hooks = {}) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true })
  if (!values.wd) throw new Error("--wd is required")
  if (positionals[0] === "decide") return decide(values)
  if (positionals[0] !== "run") throw new Error("usage: run-lane.mjs run <codex|pi> … | decide …")
  // No orphans: whatever ends the helper also ends the active attempt's group. No status is written.
  process.on("exit", () => active && killGroup(active.pid, "SIGKILL"))
  process.on("SIGTERM", () => process.exit(143))
  process.on("SIGINT", () => process.exit(130))
  return runLane(positionals[1], values, hooks)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
