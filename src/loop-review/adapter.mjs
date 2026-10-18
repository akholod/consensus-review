// Runner adapter for `claude -p`. Owns invocation, timeouts, envelope interpretation and usage
// accounting. It never decides review outcomes — it only reports what came back and how.
//
// Verified CLI behaviour is recorded in contracts/adapter.md; the fixtures under
// test/fixtures/adapter/ were captured from a real CLI and pin this interpretation.

import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { PASS_STATE } from "./schema.mjs"

const PAYLOAD_CONTRACT = JSON.parse(readFileSync(new URL("../../contracts/loop-payload.schema.json", import.meta.url), "utf8"))

/**
 * The self-contained schema `--json-schema` takes for a payload shape. The contract keeps both
 * shapes under `$defs`; the CLI needs one root, so the root is lifted out and the defs ride along.
 */
export function payloadSchema(requireKey = "findings") {
  const root = requireKey === "verdicts" ? "verifierPayload" : "discoveryPayload"
  return { ...PAYLOAD_CONTRACT.$defs[root], $defs: PAYLOAD_CONTRACT.$defs }
}

/** Tools a discovery pass must not have. `--allowed-tools` does NOT restrict — see contracts/adapter.md. */
export const DENIED_TOOLS = Object.freeze([
  "Read", "Grep", "Glob", "Bash", "Task", "WebFetch", "WebSearch",
  "Edit", "Write", "NotebookEdit", "TodoWrite",
])

/**
 * A pass runs with no MCP servers at all.
 *
 * `--disallowed-tools` names built-in tools only, so MCP tools are offered to a pass that is
 * supposed to see nothing but its prebuilt context — and whether they are blocked depends on the
 * user's own `permissions.allow`, not on anything this runtime controls. Measured: with a
 * `mcp__codegraph__*` entry allowlisted, a pass called `codegraph_explore` (which returns verbatim
 * repository source) with `permission_denials: []`. Isolation cannot rest on a setting the
 * reviewed machine is free to change, so the servers are removed rather than the tools denied.
 * Also drops ~3.7k tokens of tool schemas per call and the server startup on every spawn.
 */
export const NO_MCP = Object.freeze(["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'])

/** Basename of the system-prefix file, written into the run's temp cwd. */
export const SYSTEM_PREFIX_FILE = "system-prefix.txt"

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
  // Under `--json-schema` the CLI validates the payload and returns it in `structured_output`.
  // Prefer that copy; parsing `result` remains the fallback for envelopes without it.
  const structured = envelope.structured_output
  const payload = structured && typeof structured === "object" && !Array.isArray(structured)
    ? structured
    : extractPayload(envelope.result)

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
 *
 * `systemPrefix` carries the part of the request that is byte-identical on every call of a run
 * (the diff and its context). It goes to the system prompt, NOT into `prompt`, because the
 * whole `-p` message is a single prompt-cache block: with the prefix inside it, the varying
 * negative-space tail invalidates the prefix too and the diff is re-uploaded on every pass.
 * The saving scales with prefix size: -41% billed input on a synthetic 28k-token prefix, -5.7%
 * on a real 2k one. Kept because it is free and pays on the large diffs that actually cost.
 * See docs/loop-review-measurements.md §US-004 for what dominates the bill instead.
 *
 * It travels as a FILE, never as an argv value. Linux caps one argv string at MAX_ARG_STRLEN
 * (131,072 bytes) and the prefix is the diff plus its originals — measured at 531,693 bytes on a
 * 24-file change. Inline, `spawnSync` then fails with E2BIG before the CLI starts: no envelope,
 * no stderr, ~2ms, so EVERY pass of the run reported `failed` and the run escalated. That is a
 * tool failure indistinguishable, in the report, from a review that could not reach a verdict.
 * `--append-system-prompt-file` takes the same bytes with no size limit and yields the identical
 * system prompt, so the cache split above is unchanged. There is deliberately NO size-conditional
 * fallback to the inline form: a branch that fires only on large diffs is the branch that stays
 * broken, and this one did.
 *
 * `schema` turns on structured output: the CLI validates the reply against it and retries, so
 * the payload no longer has to be dug out of prose. Sonnet 5.5 was documented to answer JSON tasks
 * with prose around the object, which `extractPayload` can misread when that prose has braces.
 */
export function buildArgs({ prompt, systemPrefixFile = "", model = "sonnet", denied = DENIED_TOOLS, schema = null }) {
  return [
    "--disallowed-tools", denied.join(","),
    ...NO_MCP,
    // Only when non-empty: an empty value would still shift the cache prefix for no benefit.
    ...(systemPrefixFile ? ["--append-system-prompt-file", systemPrefixFile] : []),
    ...(schema ? ["--json-schema", JSON.stringify(schema)] : []),
    "--output-format", "json",
    "--model", model,
    "-p", prompt,
  ]
}

export function run({ prompt, systemPrefix = "", model = "sonnet", timeoutMs = 240_000, cwd = process.cwd(), denied = DENIED_TOOLS, bin = "claude", requireKey = "findings" }) {
  const started = Date.now()
  // The prefix is materialised inside `cwd`, which is the run's temp directory and never the
  // reviewed repository. Same name every call, so a run leaves one file rather than one per pass.
  let systemPrefixFile = ""
  if (systemPrefix) {
    systemPrefixFile = join(cwd, SYSTEM_PREFIX_FILE)
    writeFileSync(systemPrefixFile, systemPrefix)
  }
  const args = buildArgs({ prompt, systemPrefixFile, model, denied, schema: payloadSchema(requireKey) })
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
