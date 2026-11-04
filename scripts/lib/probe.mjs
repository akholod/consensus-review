// Live probes against the external tools the review depends on. Shared by two entry points:
// scripts/compat-check.mjs (release gate) and scripts/doctor.mjs (user diagnostic). One set of
// probes, so a check cannot pass for the developer and mislead the user.
//
// Every probe here costs a real call. Nothing in this file is free.

import { execFileSync, spawnSync } from "node:child_process"
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, lstatSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { run as runClaude } from "../../src/loop-review/adapter.mjs"
import { PASS_STATE_OK } from "../../src/loop-review/schema.mjs"
import { classifyClaudeResult, classifyCodexResult, laneCommand, parsePiModels } from "./lanes.mjs"

/** A tiny real defect. Probing with a genuine review task rather than a canned answer matters:
 *  asking for a fabricated empty result is what CLI 2.1.235 started refusing, and correctly. */
export const PROBE_DIFF = `diff --git a/src/take.js b/src/take.js
index 1111111..2222222 100644
--- a/src/take.js
+++ b/src/take.js
@@ -1,3 +1,3 @@
 export function take(xs, n) {
-  return xs.slice(0, Math.min(n, xs.length))
+  return xs.slice(0, n + 1)
 }`

const versionCache = new Map()

/** First line of `<bin> --version`, or null when the tool is absent. Memoised: a single diagnostic
 *  asks about the same tool more than once (consultants section, then the live probe), and a
 *  version does not change mid-run. */
export function toolVersion(bin, args = ["--version"]) {
  const key = `${bin} ${args.join(" ")}`
  if (versionCache.has(key)) return versionCache.get(key)
  let value = null
  try {
    value = execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n")[0]
  } catch {
    value = null
  }
  versionCache.set(key, value)
  return value
}

/**
 * Probe the `claude -p` envelope the loop-review adapter parses, using the production discovery
 * prompt. Returns { ok, state, checks[], detail }.
 */
export function probeClaude({ root, model = "sonnet", timeoutMs = 180_000 }) {
  const prompt = [
    "<diff>", PROBE_DIFF, "</diff>",
    "<cells>", '<cell id="source:correctness" mandatory="false">src/take.js</cell>', "</cells>",
    readFileSync(join(root, "prompts/loop-review/discovery.md"), "utf8"),
  ].join("\n\n")

  const result = runClaude({ prompt, model, timeoutMs })
  const checks = [
    ["envelope parsed and payload extracted", result.state === PASS_STATE_OK],
    ["findings array present", Array.isArray(result.payload?.findings)],
    ["cells array present", Array.isArray(result.payload?.cells)],
    ["usage.input_tokens present", typeof result.usage.input_tokens === "number"],
    ["usage.cache_read_input_tokens present", typeof result.usage.cache_read_input_tokens === "number"],
    ["cost reported", typeof result.usage.cost_usd === "number"],
  ]
  return {
    ok: checks.every(([, pass]) => pass),
    state: result.state,
    detail: result.detail ?? "",
    checks,
  }
}

/**
 * Probe codex the way the review actually calls it — read-only, with OUR findings schema and
 * `</dev/null`.
 *
 * Both details are load-bearing. `--version` passes with stale auth and with a schema codex would
 * reject, which is precisely the failure `commands/consensus-review.md` calls "a config bug to fix,
 * not a clean review". And without stdin closed codex waits for input forever rather than failing.
 */
export function probeCodex({ root, repo, timeoutSeconds = 180 }) {
  if (!toolVersion("codex")) return { ok: false, reason: "not installed" }

  const schema = join(root, "contracts/finding.schema.json")
  if (!existsSync(schema)) return { ok: false, reason: `schema missing at ${schema}` }

  const dir = mkdtempSync(join(tmpdir(), "crv-doctor-"))
  const out = join(dir, "codex.json")
  const diff = join(dir, "diff.patch")
  try {
    writeFileSync(diff, PROBE_DIFF)
    const brief = [
      `Review the diff at ${diff}.`,
      "Report findings that the diff itself supports. A P0 or P1 must name a concrete failure",
      "scenario: which input or state produces which wrong result. Respond only via the output schema.",
    ].join(" ")

    // The lane's own argv, so the doctor probes exactly the command the review runs.
    const cmd = laneCommand("codex", { repo, schema, out, brief })
    const proc = spawnSync(cmd.bin, cmd.args,
      { cwd: cmd.cwd, encoding: "utf8", timeout: timeoutSeconds * 1000, stdio: ["ignore", "pipe", "pipe"] }
    )

    const timedOut = proc.error?.code === "ETIMEDOUT" || proc.signal === "SIGTERM"
    if (timedOut) return { ok: false, reason: `timed out after ${timeoutSeconds}s` }
    // The same classifier the review's codex lane uses, so doctor and review cannot disagree.
    const result = classifyCodexResult({
      rc: proc.status, timedOut, log: `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`, outPath: out,
    })
    if (result.status !== "ok") return { ok: false, reason: result.reason }
    return { ok: true, findings: result.payload.findings.length }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** pi's local model catalog (no paid call); null when the listing fails or times out. */
export function listPiModels() {
  const r = spawnSync("pi", ["--no-extensions", "--list-models"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 })
  return r.status === 0 ? parsePiModels(r.stdout) : null
}

/** Tools the claude-cli init event may list: the --tools allowlist plus the synthetic tool that
 *  --json-schema adds (spike issue-3). Compared as a set: the CLI reorders them. */
const CLAUDE_CLI_TOOLS = ["Read", "Grep", "Glob", "StructuredOutput"]

/** Every path under `dir` with its size and mtime, sorted. `.git` included: nothing may touch it. */
function snapshot(dir) {
  const rows = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name)
      const st = lstatSync(path)
      rows.push(`${path.slice(dir.length)} ${st.size} ${st.mtimeMs}`)
      if (st.isDirectory()) walk(path)
    }
  }
  walk(dir)
  return rows.sort().join("\n")
}

/**
 * Probe the claude-cli lane's read-only promise by running the lane's exact command once, in a
 * fresh repo whose own `.claude/settings.json` carries a sentinel SessionStart hook. The proof is
 * configuration evidence, not model behaviour: the CLI's init event, the hook marker, the snapshot.
 * Returns { ok, checks[], detail }.
 */
export function probeClaudeCli({ root, timeoutMs = 180_000 }) {
  const base = mkdtempSync(join(tmpdir(), "crv-doctor-cli-"))
  const repo = join(base, "repo")
  const wd = join(base, "wd")
  const marker = join(base, "HOOK_FIRED")
  try {
    mkdirSync(join(repo, "src"), { recursive: true })
    mkdirSync(join(repo, ".claude"))
    mkdirSync(wd)
    writeFileSync(join(repo, "src/take.js"), "export function take(xs, n) {\n  return xs.slice(0, n + 1)\n}\n")
    writeFileSync(join(repo, ".claude/settings.json"), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch ${marker}` }] }] },
    }))
    execFileSync("git", ["init", "-q"], { cwd: repo })
    execFileSync("git", ["-c", "user.email=doctor@example.com", "-c", "user.name=doctor", "add", "-A"], { cwd: repo })
    execFileSync("git", ["-c", "user.email=doctor@example.com", "-c", "user.name=doctor", "commit", "-q", "-m", "probe"], { cwd: repo })
    const diff = join(wd, "diff.patch")
    writeFileSync(diff, PROBE_DIFF)
    const brief = [
      `Review the diff at ${diff}.`,
      "Report findings that the diff itself supports. A P0 or P1 must name a concrete failure",
      "scenario: which input or state produces which wrong result. Respond only via the output schema.",
    ].join(" ")

    const before = snapshot(repo)
    // The lane's own argv, env and stdin, so the doctor probes exactly the command the review runs.
    const cmd = laneCommand("claude-cli", { repo, wd, schema: join(root, "contracts/finding.schema.json"), brief })
    const proc = spawnSync(cmd.bin, cmd.args,
      { cwd: cmd.cwd, env: cmd.env, encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] }
    )
    const timedOut = proc.error?.code === "ETIMEDOUT" || proc.signal === "SIGTERM"
    const out = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`
    const result = classifyClaudeResult({ rc: proc.status, timedOut, out })

    let init = null
    for (const line of out.split("\n")) {
      try {
        const event = JSON.parse(line)
        if (event?.type === "system" && event.subtype === "init") init = event
      } catch {}
    }
    const extraTools = Array.isArray(init?.tools) ? init.tools.filter((t) => !CLAUDE_CLI_TOOLS.includes(t)) : null
    const mcp = Array.isArray(init?.mcp_servers) ? init.mcp_servers : null
    const checks = [
      ["result classified ok", result.status === "ok", result.status === "ok" ? "" : `${result.status}: ${result.reason}`],
      [`init tools within ${CLAUDE_CLI_TOOLS.join(", ")}`, extraTools?.length === 0,
        extraTools ? `extra: ${extraTools.join(", ")}` : "no init event with tools"],
      ["no MCP servers", mcp?.length === 0, mcp ? `mcp_servers: ${JSON.stringify(mcp).slice(0, 120)}` : "no init event with mcp_servers"],
      ["repo SessionStart hook did not fire", !existsSync(marker), "sentinel marker created"],
      ["repo snapshot unchanged", snapshot(repo) === before, "files in the reviewed repo changed"],
    ]
    const failed = checks.filter(([, pass]) => !pass)
    return { ok: failed.length === 0, checks, detail: failed.map(([label, , why]) => `${label}: ${why}`).join("; ") }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}
