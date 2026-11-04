// Retry-once policy for the external review lanes (codex, pi, and their refuter re-runs).
// Pure functions only: scripts/run-lane.mjs owns the processes and the files, this module owns
// every decision, so the policy is testable without a model and lives in exactly one place.
//
// A missing or broken output is never "zero findings", and a lane is never lost silently: every
// lane ends in a status whose `display` names each attempt and why it ended.

import { existsSync, readFileSync } from "node:fs"
import { validate } from "./json-schema.mjs"

export const VERDICTS = ["confirmed", "unconfirmed", "refuted"]

const MARKERS = {
  findings: ["===FINDINGS_START===", "===FINDINGS_END==="],
  verdicts: ["===VERDICTS_START===", "===VERDICTS_END==="],
}

/** A failure that a second attempt cannot fix: retrying it only doubles the wait. */
export const CONFIG_ERROR_PATTERNS = [
  /invalid_json_schema/i, /\b401\b/, /unauthorized/i, /invalid_api_key/i, /not logged in/i, /login required/i,
  /no api key/i, /model_not_found/i, /unknown model/i, /model .* does not exist/i, /unsupported model/i,
  /(unknown|unexpected) (option|argument)/i,
]

/** A CLI error line: `ERROR …` / `Error: …` / `error: …`, optionally after a log timestamp. */
const ERROR_LINE = /^(?:\[?\d{4}-\d\d-\d\dT\S*\s+)?(?:ERROR\b:?|[Ee]rror:)\s*/

/** The error text of one log line, or null. JSON events: codex `--json` and pi's JSONL. */
function errorText(line) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    return ERROR_LINE.test(line) ? line.replace(ERROR_LINE, "") || line : null
  }
  if (!event || typeof event !== "object") return null
  const last = Array.isArray(event.messages) ? event.messages.at(-1) : event.message
  if (last && typeof last === "object" && (last.stopReason === "error" || last.errorMessage)) {
    return String(last.errorMessage ?? "stopReason: error")
  }
  if (event.error && typeof event.error === "object") return String(event.error.message ?? JSON.stringify(event.error))
  if (String(event.type ?? "").includes("error")) return String(event.message ?? event.error ?? line)
  return null
}

/**
 * Only the error lines and the log tail are evidence: the log also holds the whole transcript
 * (prompt, repo files, diff hunks), where "401" or `"message"` is just content. The tail counts
 * only when no error line exists. The reason is the last error line, else the last two lines.
 */
function failure(rc, log) {
  const lines = log.trim().split("\n")
  const errors = lines.map((l) => errorText(l.trim())).filter(Boolean)
  const evidence = (errors.length ? errors : lines.slice(-5)).join("\n")
  const config = rc === 126 || rc === 127 || CONFIG_ERROR_PATTERNS.some((p) => p.test(evidence))
  const reason = (errors.at(-1) || lines.slice(-2).join(" ")).trim().slice(0, 200) || `exit ${rc}`
  return { status: config ? "config" : "failed", reason }
}

let findingSchema = null // loaded on first use, so a missing file is probeCodex's diagnostic, not an import crash

/** Findings must match the contract entry by entry; verdicts are checked per id by parseVerdicts. */
function payloadProblem(payload, requireKey) {
  if (!Array.isArray(payload?.[requireKey])) return `output has no ${requireKey} array — the schema was not honoured`
  if (requireKey !== "findings") return null
  findingSchema ??= JSON.parse(readFileSync(new URL("../../contracts/finding.schema.json", import.meta.url), "utf8"))
  const problems = validate(findingSchema, payload)
  return problems.length ? `output does not match contracts/finding.schema.json: ${problems[0]}` : null
}

/** Classify one codex attempt. `outPath` is the `-o` file; it is absent when codex failed. */
export function classifyCodexResult({ rc, timedOut, log = "", outPath, requireKey = "findings" }) {
  if (timedOut) return { status: "timeout", reason: "timed out" }
  if (rc !== 0) return failure(rc, log)
  if (!existsSync(outPath)) return { status: "unparseable", reason: "exited 0 but wrote no output file" }
  let payload
  try {
    payload = JSON.parse(readFileSync(outPath, "utf8"))
  } catch (err) {
    return { status: "unparseable", reason: `output is not valid JSON: ${err.message}` }
  }
  const problem = payloadProblem(payload, requireKey)
  return problem ? { status: "unparseable", reason: problem } : { status: "ok", payload }
}

/**
 * Read pi's JSONL events: the final answer is the last assistant message (`agent_end`, else the
 * last `turn_end`), and the payload is the LAST block between the markers for `requireKey`.
 */
export function parsePiOutput(raw, requireKey = "findings") {
  let final = null
  let fallback = null
  for (const line of raw.split("\n")) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue // stderr lines and partial writes share the file
    }
    if (event?.type === "agent_end" && Array.isArray(event.messages)) final = event.messages.at(-1)
    if (event?.type === "turn_end" && event.message) fallback = event.message
  }
  const message = final ?? fallback
  const text = (Array.isArray(message?.content) ? message.content : [])
    .filter((part) => part?.type === "text").map((part) => part.text).join("")
  const meta = { model: message?.model, provider: message?.provider }
  const [start, end] = MARKERS[requireKey]
  const from = text.lastIndexOf(start)
  const to = from < 0 ? -1 : text.indexOf(end, from)
  if (to < 0) return { status: "unparseable", reason: `no ${start} … ${end} block in the final message`, ...meta }
  let items
  try {
    items = JSON.parse(text.slice(from + start.length, to))
  } catch (err) {
    return { status: "unparseable", reason: `marker block is not valid JSON: ${err.message}`, ...meta }
  }
  if (!Array.isArray(items)) return { status: "unparseable", reason: "marker block is not a JSON array", ...meta }
  const problem = payloadProblem({ [requireKey]: items }, requireKey)
  if (problem) return { status: "unparseable", reason: problem, ...meta }
  return { status: "ok", payload: { [requireKey]: items }, ...meta }
}

/** Classify one pi attempt from its combined stdout/stderr. */
export function classifyPiResult({ rc, timedOut, out = "", requireKey = "findings" }) {
  if (timedOut) return { status: "timeout", reason: "timed out" }
  if (rc !== 0) return failure(rc, out)
  return parsePiOutput(out, requireKey)
}

/** Grace between TERM and KILL: min(5, T/4); an override is clamped to ≤ T/4 so attempt 1 ≤ 2T. */
export function killGrace(T, override) {
  const cap = T / 4
  return override == null ? Math.min(5, cap) : Math.max(0, Math.min(override, cap))
}

/**
 * One monotonic deadline per lane, D = start + 2T. `elapsed` is now − start, in seconds, after
 * attempt 1 is fully settled. Attempt 2 gets t2 = min(T, (D − now) − g), so it ends by D even if
 * it ignores TERM, and runs only when that leaves a useful window: t2 ≥ min(30, T/2).
 */
export function decideRetry({ T, g, elapsed, status }) {
  const t2 = Math.min(T, 2 * T - elapsed - g)
  if (status === "ok" || status === "config") return { retry: false, t2 }
  return { retry: t2 >= Math.min(30, T / 2), t2 }
}

const label = (a) => (a.status === "failed" || a.status === "config" ? `failed: ${a.reason}` : a.status)

/** Final lane status from its attempts. A lone failed attempt means the deadline refused the retry. */
export function laneStatus(attempts) {
  const [a1, a2] = attempts
  if (a1.status === "ok") return { status: "ok", display: "ok" }
  if (a1.status === "config") return { status: "failed", display: `failed: ${a1.reason}` }
  if (!a2) return { status: "degraded", display: `degraded (${label(a1)}; no time left)` }
  if (a2.status === "ok") return { status: "ok", display: `ok (retried: ${a1.status})` }
  return { status: "degraded", display: `degraded (${label(a1)}; ${label(a2)})` }
}

/** The exact read-only command for a lane. Changing these flags changes the read-only promise. */
export function laneCommand(lane, { repo, schema, out, model, brief }) {
  const withModel = model ? ["--model", model] : []
  if (lane === "codex") {
    return {
      bin: "codex",
      args: ["exec", "-s", "read-only", "-C", repo, "--skip-git-repo-check",
        "--output-schema", schema, "-o", out, ...withModel, brief],
      cwd: repo,
    }
  }
  if (lane === "pi") {
    // pi has no sandbox flag: the toolset IS the enforcement, so never add bash, edit or write.
    // `--tools` keeps MCP tools unless told otherwise; `--no-mcp` connects no MCP server at all.
    return { bin: "pi", args: ["-p", "--mode", "json", "--tools", "read,grep,find,ls", "--no-mcp", ...withModel, brief], cwd: repo }
  }
  throw new Error(`unknown lane "${lane}" — expected codex or pi`)
}

/**
 * Count the refuter's votes. Only `id ∈ sentIds` with a known verdict counts; an unknown id is
 * ignored (and reported); a duplicated id invalidates that id's vote. `payload` is `{ verdicts }`
 * or a bare array (finding-verifier's own format).
 */
export function parseVerdicts(payload, sentIds) {
  const items = Array.isArray(payload) ? payload : Array.isArray(payload?.verdicts) ? payload.verdicts : []
  const sent = new Set(sentIds)
  const seen = new Map()
  const ignored = []
  for (const item of items) {
    if (!sent.has(item?.id)) {
      ignored.push(item?.id)
      continue
    }
    seen.set(item.id, seen.has(item.id) ? null : item.verdict)
  }
  const votes = {}
  const duplicates = []
  for (const [id, verdict] of seen) {
    if (verdict === null) duplicates.push(id)
    else if (VERDICTS.includes(verdict)) votes[id] = verdict
  }
  return { status: Object.keys(votes).length ? "ok" : "unparseable", votes, ignored, duplicates }
}

/** The one source of truth for which refuters §8 runs; written into review.decision.json. */
export function selectRefuters(lanes, extra) {
  const pick = (name) => {
    const s = lanes[name]
    if (!s || s.status === "ok" || s.status === "degraded") return "run"
    if (s.status === "failed") return `skipped (${name} failed: ${s.attempts?.length ? "config" : "helper error"})`
    if (s.status === "unavailable") return "skipped (unavailable)"
    return s.display
  }
  const refuters = { "codex-refuter": pick("codex") }
  if (extra) refuters["pi-refuter"] = pick("pi")
  return refuters
}

/**
 * Lenient majority per finding over the voters that returned a valid verdict for it. A strict
 * majority decides; a tie or no vote at all is `unconfirmed`. Without a vote from the `verifier`
 * ballot the finding is `unconfirmed` whatever the refuters said: a refuter never decides alone.
 * `ballots` maps each voter in the set (the verifier first) to its votes; every id gets an entry,
 * `voters` reads "<n that voted> of <set size>" and `noVote` names who did not vote on it.
 */
export function tallyVotes(ids, ballots) {
  const perFinding = {}
  for (const id of ids) {
    const cast = Object.values(ballots).map((b) => b[id]).filter(Boolean)
    const counts = {}
    for (const v of cast) counts[v] = (counts[v] ?? 0) + 1
    const winner = Object.keys(counts).find((v) => counts[v] * 2 > cast.length)
    perFinding[id] = {
      decision: (ballots.verifier?.[id] && winner) || "unconfirmed",
      voters: `${cast.length} of ${Object.keys(ballots).length}`,
      noVote: Object.keys(ballots).filter((name) => !ballots[name][id]),
    }
  }
  return perFinding
}

/** The ids sent to the voters: a non-empty array of non-empty strings, or null (fail closed). */
export const validIds = (ids) =>
  Array.isArray(ids) && ids.length > 0 && ids.every((id) => typeof id === "string" && id !== "") ? ids : null

const LANE_STATUSES = ["ok", "degraded", "failed", "skipped", "unavailable"]

const isNumber = (x) => typeof x === "number" && Number.isFinite(x)

/** One attempt record exactly as scripts/run-lane.mjs writes it. */
const validAttempt = (a) => Boolean(a) && typeof a === "object" && isNumber(a.n) && typeof a.status === "string" &&
  (a.reason === null || typeof a.reason === "string") && (a.rc === null || isNumber(a.rc)) && isNumber(a.seconds)

/** A status.json is trusted only in its full shape; anything else is a helper error. */
export const validStatus = (s, lane) =>
  Boolean(s) && typeof s === "object" && s.lane === lane && LANE_STATUSES.includes(s.status) &&
  typeof s.display === "string" && Array.isArray(s.attempts) &&
  s.attempts.every(validAttempt) && (s.status !== "ok" || s.attempts.at(-1)?.status === "ok")

/** A review.decision.json refuter entry: `run` or a contract-valid `skipped (<why>)`. */
export const validRefuterEntry = (entry) => entry === "run" || /^skipped \(.+\)$/.test(entry ?? "")

/** Lane status for a missing or unreadable status.json: never read as success. */
export const helperError = (lane, reason) =>
  ({ lane, status: "failed", display: `failed: helper error (${reason})`, attempts: [] })

/** True when no external lane produced a usable review — the report's single-source warning. */
export const allExternalDown = (lanes) => !Object.values(lanes).some((s) => s.status === "ok")

export function decideReview(lanes) {
  return { lanes, allExternalDown: allExternalDown(lanes), refuters: selectRefuters(lanes, "pi" in lanes) }
}

/**
 * Every id in `ids` gets a decision, whoever voted. `verifierPayload` is undefined when the verifier
 * file is missing; a value that is not a verdict list is `invalid`. Either way the verifier casts no
 * vote and the report says so. `refuterPayloads` maps each refuter lane to its canonical payload
 * (null when it did not end ok). Skipped/unavailable refuters are not in the voter set; failed and
 * degraded ones are, with no vote.
 */
export function decideSceptic(lanes, ids, verifierPayload, refuterPayloads) {
  const verifier = verifierPayload === undefined ? "missing"
    : Array.isArray(verifierPayload) || Array.isArray(verifierPayload?.verdicts) ? "ok" : "invalid"
  if (!validIds(ids)) {
    return { lanes, error: "failed: helper error (no ids)", voteMode: null, verifier, perFinding: {} }
  }
  const refuterBallots = Object.fromEntries(Object.entries(lanes)
    .filter(([, s]) => s.status !== "skipped" && s.status !== "unavailable")
    .map(([name]) => [name, refuterPayloads[name] ? parseVerdicts(refuterPayloads[name], ids).votes : {}]))
  const ballots = { verifier: verifier === "ok" ? parseVerdicts(verifierPayload, ids).votes : {}, ...refuterBallots }
  const voteMode = Object.values(refuterBallots).some((b) => Object.keys(b).length) ? "strict" : "strict → basic"
  return { lanes, voteMode, verifier, perFinding: tallyVotes(ids, ballots) }
}
