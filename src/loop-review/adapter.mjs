// Runner adapter for `claude -p`. Owns invocation, timeouts, envelope interpretation and usage
// accounting. It never decides review outcomes — it only reports what came back and how.
//
// Verified CLI behaviour is recorded in contracts/adapter.md; the fixtures under
// test/fixtures/adapter/ were captured from a real CLI and pin this interpretation.

import { spawnSync } from "node:child_process"
import { PASS_STATE } from "./schema.mjs"

/** Tools a discovery pass must not have. `--allowed-tools` does NOT restrict — see contracts/adapter.md. */
export const DENIED_TOOLS = Object.freeze([
  "Read", "Grep", "Glob", "Bash", "Task", "WebFetch", "WebSearch",
  "Edit", "Write", "NotebookEdit", "TodoWrite",
])

const ZERO_USAGE = Object.freeze({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cost_usd: 0,
})

/** Counters must be finite, non-negative numbers: a string or object here corrupts budget
 *  accounting and later throws in the report. Anything else is reported as absent. */
const counter = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null

function readUsage(envelope) {
  const u = envelope?.usage ?? {}
  const fields = {
    input_tokens: counter(u.input_tokens),
    output_tokens: counter(u.output_tokens),
    cache_creation_input_tokens: counter(u.cache_creation_input_tokens),
    cache_read_input_tokens: counter(u.cache_read_input_tokens),
    cost_usd: counter(envelope?.total_cost_usd),
  }
  const malformed = Object.entries(fields)
    .filter(([key, v]) => v === null && (key === "cost_usd" ? envelope?.total_cost_usd : u[key]) !== undefined)
    .map(([key]) => key)
  const usage = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v ?? 0]))
  return { usage, malformed }
}

/** Pull the JSON payload out of a result string that may be fenced or surrounded by prose. */
export function extractPayload(result) {
  if (typeof result !== "string") return null
  const fenced = result.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
  const candidates = [fenced?.[1], result]
  for (const candidate of candidates) {
    if (!candidate) continue
    const start = candidate.indexOf("{")
    const end = candidate.lastIndexOf("}")
    if (start < 0 || end <= start) continue
    try {
      return JSON.parse(candidate.slice(start, end + 1))
    } catch { /* try the next candidate */ }
  }
  return null
}

/**
 * Interpret a completed invocation. Pure, so the recorded fixtures drive it directly.
 *
 * The load-bearing rule: exit status and `is_error` are NOT sufficient. A refusal returns
 * exit 0 / is_error:false / subtype:"success" with prose instead of a payload, which would
 * otherwise read as "reviewed successfully, found nothing" — the exact route to a false CLEAN.
 */
export function interpret({ rc, stdout, timedOut, requireKey = "findings" }) {
  if (timedOut || rc === 124) {
    return { state: PASS_STATE.TIMEOUT, payload: null, usage: { ...ZERO_USAGE }, detail: "runner timed out; no envelope written" }
  }

  let envelope
  try {
    envelope = JSON.parse(String(stdout))
    // `JSON.parse("null")` and `JSON.parse("[]")` both succeed but are not envelopes.
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("not an object")
  } catch {
    return {
      state: rc === 0 ? PASS_STATE.MALFORMED : PASS_STATE.FAILED,
      payload: null,
      usage: { ...ZERO_USAGE },
      detail: rc === 0 ? "stdout was not a JSON envelope" : `runner exited ${rc} without an envelope`,
    }
  }

  const { usage, malformed } = readUsage(envelope)

  if (malformed.length) {
    return { state: PASS_STATE.MALFORMED, payload: null, usage, detail: `usage field(s) not numeric: ${malformed.join(", ")}` }
  }

  if (rc !== 0 || envelope.is_error === true) {
    const detail = typeof envelope.result === "string" ? envelope.result.slice(0, 300) : `exit ${rc}`
    return { state: PASS_STATE.FAILED, payload: null, usage, detail }
  }

  if (typeof envelope.result !== "string") {
    // Anything else — an object, an array, a hostile toString — is not a response we can read.
    return { state: PASS_STATE.MALFORMED, payload: null, usage, detail: "envelope result is not a string" }
  }
  const payload = extractPayload(envelope.result)

  if (envelope.stop_reason === "max_tokens") {
    return { state: PASS_STATE.TRUNCATED, payload, usage, detail: "response hit max_tokens; content is incomplete" }
  }
  if (!payload) {
    // Prose where a payload was required. Cannot be distinguished from a refusal by exit status,
    // and must never be treated as an empty-but-valid result.
    return { state: PASS_STATE.REFUSED, payload: null, usage, detail: envelope.result.slice(0, 300) }
  }
  if (!Array.isArray(payload[requireKey])) {
    return { state: PASS_STATE.MALFORMED, payload, usage, detail: `payload has no ${requireKey} array` }
  }
  // Members must be objects. `{"findings":[null]}` would otherwise be read as a clean pass.
  const bad = payload[requireKey].findIndex((m) => !m || typeof m !== "object" || Array.isArray(m))
  if (bad >= 0) {
    return { state: PASS_STATE.MALFORMED, payload, usage, detail: `${requireKey}[${bad}] is not an object` }
  }
  // A discovery payload must always carry `cells`, even empty. Accepting its absence let a pass
  // say nothing about coverage at all and still count as a clean result.
  if (requireKey === "findings" && !Array.isArray(payload.cells)) {
    return { state: PASS_STATE.MALFORMED, payload, usage, detail: "discovery payload has no cells array" }
  }

  return { state: PASS_STATE.OK, payload, usage, detail: "" }
}

/**
 * Invoke the runner. Flags precede `-p` deliberately: `--disallowed-tools` is variadic and
 * swallows a trailing positional prompt (contracts/adapter.md).
 */
export function run({ prompt, model = "sonnet", timeoutMs = 240_000, cwd = process.cwd(), denied = DENIED_TOOLS, bin = "claude", requireKey = "findings" }) {
  const started = Date.now()
  const args = [
    "--disallowed-tools", denied.join(","),
    "--output-format", "json",
    "--model", model,
    "-p", prompt,
  ]
  const proc = spawnSync(bin, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  })
  const timedOut = proc.error?.code === "ETIMEDOUT" || proc.signal === "SIGTERM"
  const result = interpret({ rc: proc.status ?? 1, stdout: proc.stdout ?? "", timedOut, requireKey })
  return { ...result, ms: Date.now() - started, modelId: model, runnerId: bin }
}
