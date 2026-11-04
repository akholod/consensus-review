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

/** A claude-cli failure a retry cannot fix, matched on the envelope's error text only. */
const CLAUDE_CONFIG_PATTERNS = [
  /Invalid API key/i, /Please run \/login/i, /issue with the selected model/i,
  /may not exist or you may not have access/i, /credit balance/i,
]

/**
 * Classify one claude-cli attempt. The envelope is the last `type: "result"` JSON line of the mixed
 * stdout/stderr log (stream-json; a single `--output-format json` envelope also qualifies). With
 * `--json-schema` a refusal comes back as a valid empty payload, so it cannot be told from a clean run.
 */
export function classifyClaudeResult({ rc, timedOut, out = "", requireKey = "findings" }) {
  let envelope = null
  let init = null
  for (const line of out.split("\n")) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event?.type === "result") envelope = event
    if (event?.type === "system" && event.subtype === "init") init = event
  }
  const model = init?.model ?? Object.keys(envelope?.modelUsage ?? {})[0] ?? null
  const result = (() => {
    if (timedOut) return { status: "timeout", reason: "timed out" }
    if (!envelope) return rc !== 0 ? failure(rc, out) : { status: "failed", reason: "exited 0 with no result envelope" }
    if (envelope.is_error || rc !== 0) {
      const text = String(envelope.result || envelope.subtype || `exit ${rc}`)
      const config = CLAUDE_CONFIG_PATTERNS.some((p) => p.test(text))
      return { status: config ? "config" : "failed", reason: text.trim().slice(0, 200) }
    }
    if (envelope.stop_reason === "max_tokens") return { status: "unparseable", reason: "stopped at max_tokens" }
    const problem = payloadProblem(envelope.structured_output, requireKey)
    return problem ? { status: "unparseable", reason: problem } : { status: "ok", payload: envelope.structured_output }
  })()
  return { ...result, model }
}

/** The claude-cli model when none is requested: the only place this default lives. */
export const CLAUDE_CLI_MODEL = "sonnet"

/** A nested `claude -p` must not join the calling Claude Code session. Only the session-binding
 *  variables go: auth/provider ones (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_OAUTH_TOKEN`, …) stay. */
const SESSION_ENV = /^(CLAUDECODE|CLAUDE_CODE_(SESSION_ID|ENTRYPOINT|MESSAGING_SOCKET\w*))$/
const scrubbedEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !SESSION_ENV.test(key)))

/** pi's isolation flags; `run-lane select` lists models with `--no-extensions` too, so the catalog matches a run. */
const PI_ISOLATION = ["--no-extensions", "--no-session", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve"]

/** The exact read-only command for a lane. Changing these flags changes the read-only promise. */
export function laneCommand(lane, { repo, wd, schema, out, model, brief }) {
  const withModel = model ? ["--model", model] : []
  if (lane === "claude-cli") {
    // No write tool exists at all (--tools), no MCP, no hooks or settings from the reviewed repo
    // (--safe-mode --restricted); the file tools reach only cwd and the work dir. Spike: issue-3.
    const inlineSchema = JSON.stringify(JSON.parse(readFileSync(schema, "utf8")))
    return {
      bin: "claude",
      args: ["--safe-mode", "--restricted", "--tools", "Read,Grep,Glob", "--add-dir", wd, "--no-session-persistence",
        "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--permission-mode", "dontAsk",
        "--json-schema", inlineSchema, "--output-format", "stream-json", "--verbose",
        "--model", model || CLAUDE_CLI_MODEL, "-p", brief],
      cwd: repo,
      env: scrubbedEnv(),
    }
  }
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
    // PI_ISOLATION is pi's equivalent of claude's --safe-mode --restricted: no extension code, no
    // saved session, no skills, prompt templates, context files or project-local config.
    return {
      bin: "pi",
      args: ["-p", "--mode", "json", "--tools", "read,grep,find,ls", "--no-mcp", ...PI_ISOLATION, ...withModel, brief],
      cwd: repo,
    }
  }
  throw new Error(`unknown lane "${lane}" — expected codex, pi or claude-cli`)
}

/** The panel's model family: a lane of this family is independent by context only. */
const PANEL_FAMILY = "anthropic"

/** pi's family by positive match over `${provider} ${model}`; first match wins, anthropic first. */
const PI_FAMILIES = [
  [/claude|anthropic/i, "anthropic"], [/openai|gpt|codex|\bo[1-9]\b/i, "openai"], [/gemini|google/i, "google"],
  [/deepseek/i, "deepseek"], [/qwen/i, "qwen"], [/mistral/i, "mistral"], [/llama|meta/i, "meta"],
  [/grok|xai/i, "xai"], [/glm|zhipu/i, "zhipu"], [/kimi|moonshot/i, "moonshot"],
]

/** The model family of a lane run. Anything not positively identified is `unknown`, which never votes. */
export function family(kind, status) {
  if (kind === "codex") return "openai"
  if (kind === "claude-cli") return "anthropic"
  if (kind !== "pi") return "unknown"
  const text = `${status?.provider ?? ""} ${status?.model ?? ""}`.trim()
  return (text && PI_FAMILIES.find(([pattern]) => pattern.test(text))?.[1]) || "unknown"
}

/** The lane kind of a status: its `kind`, else its name without `-refuter` (older work dirs). */
const kindOf = (name, s) => s?.kind ?? name.replace(/-refuter$/, "")

const independence = (fam) => (fam === "unknown" ? "unknown" : fam === PANEL_FAMILY ? "context" : "model")

/** `pi --list-models` rows: a whitespace-aligned table, col 1 the provider, col 2 the model. */
export function parsePiModels(text) {
  return text.split("\n").map((line) => line.trim().split(/\s+/))
    .filter(([provider, model], i) => model && !(i === 0 && provider === "provider"))
    .map(([provider, model]) => ({ provider, model }))
}

const startsWith = (prefix) => (row) => row.model.startsWith(prefix)
const INDEPENDENT_PI = [["glm", startsWith("glm")], ["qwen", startsWith("qwen")], ["kimi", startsWith("kimi")]]
const PI_PREFERENCE = {
  primary: [["openai-codex", (row) => row.provider === "openai-codex"], ["gpt", startsWith("gpt-")], ...INDEPENDENT_PI],
  extra: INDEPENDENT_PI,
}

/**
 * pi's model for a role: the newest row of the first preferred group present. Never a Claude model,
 * never pi's unpinned default. "Newest" is the numeric-aware maximum; a tie keeps catalog order.
 */
export function pickPiModel(role, rows) {
  const usable = (rows ?? []).filter((row) => !/flash|free|mini/.test(row.model) && family("pi", row) !== PANEL_FAMILY)
  for (const [group, match] of PI_PREFERENCE[role]) {
    const best = usable.filter(match).reduce((a, b) => (!a || b.model.localeCompare(a.model, undefined, { numeric: true }) > 0 ? b : a), null)
    if (best) return { model: `${best.provider}/${best.model}`, group }
  }
  return { none: role === "primary" ? "no non-Claude pi model" : "no independent pi model" }
}

/** Prompt names by lane kind: [lane brief, refuter brief]. */
export const BRIEFS = {
  codex: ["brief.md", "refuter-brief.md"],
  "claude-cli": ["brief.md", "refuter-brief.md"],
  pi: ["brief-pi.md", "refuter-brief-pi.md"],
}
const INSTALLED_KEY = { codex: "codex", pi: "pi", "claude-cli": "claude" }

/** `skipReason` undefined: the lane runs; a string or null: it is `unavailable` for that reason. */
const consultantLane = (name, model, skipReason) => ({
  name, brief: BRIEFS[name][0], refuterBrief: BRIEFS[name][1], model: model ?? null,
  skip: skipReason === undefined ? null : "unavailable", skipReason: skipReason ?? null,
})

/**
 * Which external lanes run, from the harnesses present: `codex → pi → claude-cli`, or the forced
 * `consultant` (alias `claude`), never substituted. `piModels` is parsePiModels' rows, or null when
 * the listing failed. Pure: the caller detects `installed` and lists pi's models.
 */
export function selectConsultants({ installed, consultant, extra, extraModel, piModels }) {
  const forced = consultant === "claude" ? "claude-cli" : consultant || null
  if (forced && !BRIEFS[forced]) throw new Error(`unknown consultant "${consultant}" — expected codex, pi or claude-cli`)
  const piModel = (role) => {
    if (extraModel) return { model: extraModel, why: "extra-advisor model" }
    if (!piModels) return { none: role === "primary" ? "pi --list-models failed" : "no independent pi model" }
    const pick = pickPiModel(role, piModels)
    return pick.none ? pick : { model: pick.model, why: `${pick.group} preferred${role === "extra" ? " for independence" : ""}` }
  }
  const notes = []
  let primary
  if (forced) {
    if (!installed[INSTALLED_KEY[forced]]) {
      primary = consultantLane(forced, null, "forced, not installed")
      notes.push(`consultant=${forced}: forced, not installed`)
    } else if (forced === "pi") {
      const pick = piModel("primary")
      primary = consultantLane("pi", pick.model, pick.none)
      notes.push(pick.none ? `consultant=pi: ${pick.none}` : `consultant=pi: ${pick.model} (${pick.why})`)
    } else {
      primary = consultantLane(forced, forced === "claude-cli" ? CLAUDE_CLI_MODEL : null)
      notes.push(`consultant=${forced}: forced`)
    }
  } else if (installed.codex) {
    primary = consultantLane("codex", null)
    notes.push("codex: first installed")
  } else {
    if (installed.pi) {
      const pick = piModel("primary")
      if (pick.model) {
        primary = consultantLane("pi", pick.model)
        notes.push(`pi: codex not installed; ${pick.model} (${pick.why})`)
      } else notes.push(`pi not usable (${pick.none})`)
    }
    if (!primary && installed.claude) {
      primary = consultantLane("claude-cli", CLAUDE_CLI_MODEL)
      notes.push("claude-cli: no other consultant usable")
    }
    if (!primary) {
      primary = consultantLane("codex", null, null)
      notes.push("no consultant installed")
    }
  }
  const lanes = [primary]
  let extraNote = null
  if (extra && primary.name === "pi") extraNote = "skipped (pi is the consultant)"
  else if (extra && !installed.pi) lanes.push(consultantLane("pi", null, "not installed"))
  else if (extra) {
    const pick = piModel("extra")
    lanes.push(consultantLane("pi", pick.model, pick.none))
    notes.push(pick.none ? `pi as extra: ${pick.none}` : `pi as extra: ${pick.model} (${pick.why})`)
  }
  return { lanes, extraNote, reason: notes.join("; ") }
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

/**
 * The one source of truth for which refuters §8 runs; written into review.decision.json. One
 * `<name>-refuter` per lane present; at most one runs per known family, none from the panel's.
 */
export function selectRefuters(lanes) {
  const voting = {} // family → the first lane of it that votes
  const pick = (name, s) => {
    if (s.status === "failed") return `skipped (${name} failed: ${s.attempts?.length ? "config" : "helper error"})`
    if (s.status === "unavailable") return "skipped (unavailable)"
    if (s.status !== "ok" && s.status !== "degraded") return s.display
    const fam = family(kindOf(name, s), s)
    if (fam === "unknown") return "skipped (independence unknown)"
    if (fam === PANEL_FAMILY) return "skipped (same-family)"
    if (voting[fam]) return `skipped (same-family as ${voting[fam]})`
    voting[fam] = name
    return "run"
  }
  return Object.fromEntries(Object.entries(lanes).map(([name, s]) => [`${name}-refuter`, pick(name, s)]))
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
  ({ lane, kind: lane.replace(/-refuter$/, ""), brief: null, requestedModel: null, status: "failed", display: `failed: helper error (${reason})`, attempts: [] })

/** True when no external lane produced a usable review — the report's single-source warning. */
export const allExternalDown = (lanes) => !Object.values(lanes).some((s) => s.status === "ok")

/** `lanes` in `--lanes` order: the primary first, then the extra. */
export function decideReview(lanes) {
  const families = Object.entries(lanes).map(([name, s]) => [name, family(kindOf(name, s), s)])
  // Only lanes that produced a review can collide: an unavailable primary has no engine to share.
  const usable = (name) => ["ok", "degraded"].includes(lanes[name]?.status)
  const [primary, extra] = families.map(([name, fam]) => (usable(name) ? fam : undefined))
  return {
    lanes,
    allExternalDown: allExternalDown(lanes),
    family: Object.fromEntries(families),
    independence: Object.fromEntries(families.map(([name, fam]) => [name, independence(fam)])),
    extraSameEngine: primary !== undefined && extra !== undefined && extra !== "unknown" && extra === primary,
    refuters: selectRefuters(lanes),
  }
}

/**
 * Every id in `ids` gets a decision, whoever voted. `verifierPayload` is undefined when the verifier
 * file is missing; a value that is not a verdict list is `invalid`. Either way the verifier casts no
 * vote and the report says so. `refuterPayloads` maps each refuter lane to its canonical payload
 * (null when it did not end ok). Skipped/unavailable refuters are not in the voter set; failed and
 * degraded ones are, with no vote. An ok refuter whose own run is of the panel's family, of a family
 * already counted, or `unknown` is left out of the set and named in `excluded`.
 */
export function decideSceptic(lanes, ids, verifierPayload, refuterPayloads) {
  const verifier = verifierPayload === undefined ? "missing"
    : Array.isArray(verifierPayload) || Array.isArray(verifierPayload?.verdicts) ? "ok" : "invalid"
  if (!validIds(ids)) {
    return { lanes, error: "failed: helper error (no ids)", voteMode: null, verifier, perFinding: {} }
  }
  const excluded = {}
  const counted = {} // family → the refuter that votes for it
  const voters = Object.entries(lanes).filter(([name, s]) => {
    if (s.status === "skipped" || s.status === "unavailable") return false
    if (s.status !== "ok") return true
    const fam = family(kindOf(name, s), s)
    if (fam === "unknown") excluded[name] = "family unknown"
    else if (fam === PANEL_FAMILY) excluded[name] = `family ${fam} (panel)`
    else if (counted[fam]) excluded[name] = `family ${fam} (as ${counted[fam]})`
    else counted[fam] = name
    return !excluded[name]
  })
  const refuterBallots = Object.fromEntries(voters
    .map(([name]) => [name, refuterPayloads[name] ? parseVerdicts(refuterPayloads[name], ids).votes : {}]))
  const ballots = { verifier: verifier === "ok" ? parseVerdicts(verifierPayload, ids).votes : {}, ...refuterBallots }
  const familySkip = Object.values(lanes).some((s) => /^skipped \((same-family|independence unknown)/.test(s.display))
  const voteMode = Object.values(refuterBallots).some((b) => Object.keys(b).length) ? "strict"
    : !voters.length && (familySkip || Object.keys(excluded).length) ? "strict → basic (no independent refuter)"
      : "strict → basic"
  return { lanes, voteMode, verifier, excluded, perFinding: tallyVotes(ids, ballots) }
}
