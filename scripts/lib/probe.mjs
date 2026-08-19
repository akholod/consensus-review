// Live probes against the external tools the review depends on. Shared by two entry points:
// scripts/compat-check.mjs (release gate) and scripts/doctor.mjs (user diagnostic). One set of
// probes, so a check cannot pass for the developer and mislead the user.
//
// Every probe here costs a real call. Nothing in this file is free.

import { execFileSync, spawnSync } from "node:child_process"
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { run as runClaude } from "../../src/loop-review/adapter.mjs"
import { PASS_STATE_OK } from "../../src/loop-review/schema.mjs"

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

    const proc = spawnSync(
      "codex",
      [
        "exec", "-s", "read-only", "-C", repo, "--skip-git-repo-check",
        "--output-schema", schema, "-o", out, brief,
      ],
      { encoding: "utf8", timeout: timeoutSeconds * 1000, stdio: ["ignore", "pipe", "pipe"] }
    )

    const timedOut = proc.error?.code === "ETIMEDOUT" || proc.signal === "SIGTERM"
    if (timedOut) return { ok: false, reason: `timed out after ${timeoutSeconds}s` }
    if (proc.status !== 0) {
      // The command reads the reason out of the log for its section-9 status; do the same here.
      const log = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`
      const message = log.match(/"message"\s*:\s*"([^"]+)"/)?.[1]
      return { ok: false, reason: message || log.trim().split("\n").slice(-2).join(" ").slice(0, 200) || `exit ${proc.status}` }
    }
    if (!existsSync(out)) {
      // Never read a missing file as "zero findings" — the same rule the command states.
      return { ok: false, reason: "exited 0 but wrote no output file" }
    }
    let payload
    try {
      payload = JSON.parse(readFileSync(out, "utf8"))
    } catch (err) {
      return { ok: false, reason: `output is not valid JSON: ${err.message}` }
    }
    if (!Array.isArray(payload?.findings)) {
      return { ok: false, reason: "output has no findings array — the schema was not honoured" }
    }
    return { ok: true, findings: payload.findings.length }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
