// Shapes, policy constants and the completion rules for /loop-review.
// Everything here is deterministic: no review reasoning lives in JavaScript.

/** Terminal states. Only CLEAN asserts the absence of findings, and only under the full conjunction. */
export const TERMINAL = Object.freeze({
  CLEAN: "CLEAN",
  FINDINGS: "FINDINGS",
  INCONCLUSIVE: "INCONCLUSIVE",
  ESCALATE: "ESCALATE",
})

/** Adapter outcomes. Only `ok` may contribute findings. */
export const PASS_STATE = Object.freeze({
  OK: "ok",
  MALFORMED: "malformed",
  TRUNCATED: "truncated",
  REFUSED: "refused",
  TIMEOUT: "timeout",
  FAILED: "failed",
})

export const PASS_STATE_OK = PASS_STATE.OK

/**
 * Pass policy, verbatim from the accepted baseline (docs/loop-review-plan.md §Required behavior).
 * These are not tunable at run time — a shorter run than the policy allows cannot report CLEAN.
 */
export const PASS_POLICY = Object.freeze({
  LIGHTWEIGHT_MIN: 0, // docs / generated / formatting-only
  LIGHTWEIGHT_MAX: 1,
  NON_TRIVIAL_MIN: 2, // every non-trivial code diff
  HIGH_RISK_MIN: 3, // auth, permission, migration, destructive data, public contract, cross-service
  HARD_MAX: 4, // beyond this the run escalates rather than looping again
})

/** Change surfaces, mirroring the triage classes in commands/consensus-review.md §3.1. */
export const SURFACE = Object.freeze({
  SOURCE: "source",
  CONFIG: "config-as-code",
  MANIFEST: "dependency-manifest",
  MIGRATION: "migration",
  TESTS: "tests",
  NON_CODE: "non-code",
})

/** Risk categories a pass can be directed at. */
export const RISK = Object.freeze({
  CORRECTNESS: "correctness",
  SECURITY: "security",
  DATA: "data",
  CONTRACT: "contract",
  CONCURRENCY: "concurrency",
  ERROR_HANDLING: "error-handling",
  TESTS: "tests",
})

/** Risk categories whose failure mode does not scale with diff size. */
export const HIGH_RISK = Object.freeze([RISK.SECURITY, RISK.DATA, RISK.CONTRACT])

export const SEVERITY = Object.freeze(["P0", "P1", "P2"])
export const ACTIONABLE = Object.freeze(["P0", "P1"])

/** finding-verifier's real vocabulary. `reduced` is derived, never emitted — see contracts/severity-bars.md. */
export const VERDICT = Object.freeze(["confirmed", "unconfirmed", "refuted"])

/**
 * Evidence must point somewhere. A length threshold alone let "not a real issue" erase a real
 * P1, so a confirmation or refutation has to cite a location in the finding's own file.
 */
export function evidenceSubstantiates(evidence, file) {
  if (typeof evidence !== "string") return false
  const text = evidence.trim()
  if (text.length < 20) return false
  if (!file) return false
  // The full path or its basename both count: a verifier writing "the guard in guard.js" is
  // grounding its claim, while "not a real issue" is not. The bar is that the claim points at
  // the code under review, not that it repeats the path verbatim.
  // Compare path-like tokens exactly. Raw substring matching let text about "other-schema.mjs"
  // substantiate a claim about "schema.mjs".
  const base = String(file).split("/").pop()
  for (const token of text.split(/[\s,;()\[\]{}'"`]+/)) {
    if (!token) continue
    const cleaned = token.replace(/^[^A-Za-z0-9_./-]+|[^A-Za-z0-9_./-]+$/g, "")
    if (!cleaned) continue
    // A citation usually carries a location — "guard.js:2" names guard.js just as well as
    // "guard.js" does, so compare the path part rather than the raw token.
    const path = parseAnchor(cleaned)?.path ?? cleaned
    for (const candidate of [cleaned, path]) {
      if (candidate === file || candidate === base) return true
      if (candidate.endsWith(`/${base}`) && file.endsWith(candidate)) return true
    }
  }
  return false
}

export function normalizeVerdict(verdict, reportedSeverity, suggestedSeverity) {
  if (!VERDICT.includes(verdict)) return { verdict: "unconfirmed", reduced: false }
  const lower =
    verdict === "confirmed" &&
    suggestedSeverity &&
    SEVERITY.indexOf(suggestedSeverity) > SEVERITY.indexOf(reportedSeverity)
  return { verdict: lower ? "reduced" : verdict, reduced: Boolean(lower) }
}

/** Whether an anchor is a usable location for this cell: right file, line within the context. */
export function validAnchor(anchor, cell) {
  const parsed = parseAnchor(anchor)
  if (!parsed) return false
  const basenames = new Map((cell?.files ?? []).map((f) => [String(f).split("/").pop(), f]))
  const path = (cell?.files ?? []).includes(parsed.path) ? parsed.path : basenames.get(parsed.path)
  if (!path) return false
  const limit = cell?.maxLine?.[path]
  if (limit === 0) return false
  if (limit === undefined) return true
  if (parsed.line == null) return false
  return parsed.line >= 1 && (parsed.lineEnd ?? parsed.line) <= limit
}

/** `path:line` — the line is optional but must be numeric when present. */
export function parseAnchor(anchor) {
  const text = safeString(anchor).trim()
  if (!text) return null
  const cut = text.lastIndexOf(":")
  if (cut <= 0) return { path: text, line: null }
  const tail = text.slice(cut + 1)
  // `path:12` and `path:12-18` are both ordinary ways to cite a location; a range is not a
  // fabricated anchor, and rejecting it made real coverage look like no coverage at all.
  const range = tail.match(/^([0-9]+)(?:-([0-9]+))?$/)
  if (!range) return { path: text, line: null }
  const start = Number(range[1])
  const end = range[2] ? Number(range[2]) : start
  if (end < start) return { path: text, line: null } // a reversed range is not a location
  return { path: text.slice(0, cut), line: start, lineEnd: end }
}

/** A coverage cell is one (surface × risk) pair the run is obliged to address. */
export function makeCell(surface, risk, files) {
  return { id: `${surface}:${risk}`, surface, risk, files: [...files], mandatory: HIGH_RISK.includes(risk) }
}

/**
 * An evidence record is what a pass returns FOR a cell. Dispatch is not coverage:
 * a cell counts as covered only when its record validates.
 */
export function validateEvidence(record, cell) {
  const problems = []
  if (!record || typeof record !== "object" || Array.isArray(record)) return ["evidence record is not an object"]
  if (typeof record.cell !== "string" || !record.cell) problems.push("missing cell id")
  if (!["covered", "uncovered"].includes(record.status)) problems.push("status must be covered|uncovered")

  // Bail out before touching the arrays: a malformed `anchors` or `checks` (a bare string, say)
  // must produce a rejected record, never a crash inside the runtime.
  const anchors = record.anchors
  const checks = record.checks
  if (!Array.isArray(anchors)) problems.push("anchors must be an array")
  if (!Array.isArray(checks)) problems.push("checks must be an array")
  if (record.context_complete !== true && record.context_complete !== false) {
    problems.push("context_complete must be boolean")
  }
  if (problems.length) return problems

  if (record.status === "covered") {
    // "I looked at nothing and found nothing" is not coverage.
    if (!anchors.length) problems.push("covered cell cites no anchors")
    if (!checks.length) problems.push("covered cell lists no checks")
    if (anchors.some((a) => typeof a !== "string" || !a.trim())) problems.push("anchors must be non-empty strings")
    if (checks.some((c) => typeof c !== "string" || !c.trim())) problems.push("checks must be non-empty strings")
    if (typeof record.context_used !== "string" || !record.context_used.trim()) {
      problems.push("covered cell does not name the context it used")
    }
    if (!["none", "reported", "inconclusive"].includes(record.disposition)) {
      problems.push('disposition must be "none", "reported" or "inconclusive"')
    }
    // One shared definition of a usable location, so admission and approval cannot diverge.
    if (!problems.length && !anchors.some((a) => validAnchor(a, cell))) {
      problems.push(`no anchor names an inspectable location in this cell (${(cell?.files ?? []).join(", ") || "no files"})`)
    }
  }
  return problems
}

export function validateFinding(finding) {
  const problems = []
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) return ["finding is not an object"]

  for (const key of ["title", "file", "rationale"]) {
    if (typeof finding[key] !== "string" || !finding[key].trim()) problems.push(`missing ${key}`)
  }
  if (!SEVERITY.includes(finding.severity)) problems.push("severity must be P0|P1|P2")
  // The contract in prompts/loop-review/discovery.md declares every key, so an omitted one is a
  // malformed record rather than an implied default.
  if (!CATEGORIES.includes(finding.category)) problems.push(`category must be one of ${CATEGORIES.join("|")}`)
  if (!["low", "medium", "high"].includes(finding.confidence)) problems.push("confidence must be low|medium|high")
  // Nullable fields must still be present and correctly typed: a non-string scenario would
  // otherwise satisfy the evidence bar simply by existing.
  for (const key of ["line", "failure_scenario", "suggested_fix"]) {
    if (!(key in finding)) { problems.push(`missing ${key} (use null when absent)`); continue }
    const value = finding[key]
    if (value !== null && typeof value !== "string" && typeof value !== "number") {
      problems.push(`${key} must be a string, a number, or null`)
    }
  }
  if (ACTIONABLE.includes(finding.severity)) {
    const scenario = finding.failure_scenario
    if (typeof scenario !== "string" || !scenario.trim()) {
      // The P0/P1 evidence bar, enforced structurally rather than hoped for in a prompt.
      problems.push("P0/P1 requires a concrete failure_scenario")
    }
  }
  return problems
}

export const CATEGORIES = Object.freeze(["security", "correctness", "perf", "maintainability", "tests", "style"])

/**
 * Coerce to a string without ever invoking a hostile `toString`. A parsed JSON value such as
 * `{"toString": null}` throws under `String(...)`, which would crash the runtime while it was
 * busy rejecting that very record.
 */
export function safeString(value) {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value == null) return ""
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return ""
  }
}

/** Collapse to a single bounded line so no field can smuggle prose across the pass boundary. */
const oneLine = (value, max) => safeString(value).replace(/\s+/g, " ").trim().slice(0, max)

export function fingerprint(finding) {
  const file = oneLine(finding?.file, 200)
  const rawLine = finding?.line == null ? "-" : oneLine(finding.line, 12)
  const line = /^[0-9]+(-[0-9]+)?$/.test(rawLine) ? rawLine : "-"
  const category = CATEGORIES.includes(finding?.category) ? finding.category : "uncategorised"
  return `${file}:${line}:${category}:${oneLine(finding?.title, 120)}`
}

export function minimumPasses({ trivial, highRisk }) {
  if (trivial) return PASS_POLICY.LIGHTWEIGHT_MIN
  return highRisk ? PASS_POLICY.HIGH_RISK_MIN : PASS_POLICY.NON_TRIVIAL_MIN
}

export function newRunState({ target, diffHash, cells, trivial, highRisk, budget }) {
  return {
    target,
    diffHash,
    trivial: Boolean(trivial),
    highRisk: Boolean(highRisk),
    minPasses: minimumPasses({ trivial, highRisk }),
    maxPasses: trivial ? PASS_POLICY.LIGHTWEIGHT_MAX : PASS_POLICY.HARD_MAX,
    cells: cells.map((c) => ({ ...c, covered: false, evidence: null, verifiedIndependently: false })),
    passes: [],
    verifications: [],
    rejections: [],
    findings: [],
    refuted: [],
    budget: { tokens: 0, calls: 0, ms: 0, ...budget },
    spent: { tokens: 0, calls: 0, ms: 0 },
    escalations: [],
  }
}

export function budgetExhausted(run) {
  const b = run.budget
  const s = run.spent
  return (
    (b.tokens > 0 && s.tokens >= b.tokens) ||
    (b.calls > 0 && s.calls >= b.calls) ||
    (b.ms > 0 && s.ms >= b.ms)
  )
}

export function isStale(run, currentDiffHash) {
  return run.diffHash !== currentDiffHash
}

/**
 * The CLEAN conjunction. Every clause must hold; the first failure is reported as the reason,
 * so a run can never present a mechanical shortfall as a clean bill of health.
 */
/**
 * A finding is reportable when it survived verification, or when it is a P2 that cleared the
 * admission bar. P2s are deliberately not adversarially verified (the same scope as the
 * consensus-review sceptic), so requiring a verdict from them would make a valid P2 invisible
 * to the terminal decision and let a run with real findings report CLEAN.
 */
export function isReportable(finding) {
  if (finding.unverified) return false
  if (finding.verdict === "confirmed" || finding.verdict === "reduced") return true
  return finding.severity === "P2" && finding.verdict !== "refuted"
}

/**
 * An actionable candidate that was neither confirmed nor refuted is *unresolved*. It is not
 * reportable — it was never grounded — but it must still block CLEAN, otherwise "we could not
 * tell" silently becomes "there is nothing there".
 */
export function isUnresolvedActionable(finding) {
  // A finding rejected by structural validation counts too: a malformed severity such as "p1"
  // would otherwise slip past ACTIONABLE and leave the run free to report CLEAN.
  if (finding.unverified) return true
  if (!ACTIONABLE.includes(finding.severity)) return false
  return finding.verdict !== "confirmed" && finding.verdict !== "reduced" && finding.verdict !== "refuted"
}

export function evaluateTerminal(run, currentDiffHash) {
  const reasons = []

  if (isStale(run, currentDiffHash)) {
    return { state: TERMINAL.INCONCLUSIVE, reasons: ["diff changed during the run (stale snapshot)"] }
  }

  const failedPasses = run.passes.filter((p) => p.state !== PASS_STATE_OK)
  if (failedPasses.length) reasons.push(`${failedPasses.length} pass(es) failed or truncated: ${failedPasses.map((p) => p.state).join(", ")}`)

  if (run.passes.length < run.minPasses) reasons.push(`only ${run.passes.length} of ${run.minPasses} required passes completed`)

  // Every derived cell must be covered, not only the mandatory ones. Requiring coverage of the
  // mandatory subset alone let an ordinary source diff complete with nothing actually inspected.
  const uncovered = run.cells.filter((c) => !c.covered)
  if (uncovered.length) {
    const mandatory = uncovered.filter((c) => c.mandatory).map((c) => c.id)
    reasons.push(
      `cell(s) uncovered: ${uncovered.map((c) => c.id).join(", ")}` +
      (mandatory.length ? ` (mandatory: ${mandatory.join(", ")})` : "")
    )
  }

  const unverifiedHighRisk = run.cells.filter((c) => c.mandatory && c.covered && !c.verifiedIndependently)
  if (unverifiedHighRisk.length) reasons.push(`high-risk cell(s) lack independent verification: ${unverifiedHighRisk.map((c) => c.id).join(", ")}`)

  const unresolved = run.findings.filter(isUnresolvedActionable)
  if (unresolved.length) reasons.push(`${unresolved.length} actionable finding(s) left unresolved: ${unresolved.map((f) => f.fingerprint ?? f.title).join(", ")}`)

  if (budgetExhausted(run)) reasons.push("budget exhausted before the run completed")

  if (run.rejections?.length) reasons.push(...run.rejections)

  const confirmed = run.findings.filter(isReportable)

  // Escalation outranks a findings report: these are conditions a human must see.
  if (run.escalations.length) return { state: TERMINAL.ESCALATE, reasons: run.escalations.slice() }
  // Reaching the ceiling is only benign if there was nothing left to do. A new theme on the last
  // allowed pass, or coverage still outstanding, is exactly the case the contract escalates on.
  if (run.passes.length >= run.maxPasses && !run.trivial) {
    const last = run.passes[run.passes.length - 1]
    const workRemaining = uncovered.length > 0 || (last && last.newFindings > 0)
    if (workRemaining) {
      return {
        state: TERMINAL.ESCALATE,
        reasons: [`pass ceiling ${run.maxPasses} reached with work outstanding`, ...reasons],
      }
    }
  }
  if (run.passes.length > run.maxPasses) return { state: TERMINAL.ESCALATE, reasons: [`pass ceiling ${run.maxPasses} exceeded`] }

  if (confirmed.length) return { state: TERMINAL.FINDINGS, reasons: [`${confirmed.length} confirmed finding(s)`] }
  if (reasons.length) return { state: TERMINAL.INCONCLUSIVE, reasons }

  // A final complementary pass that produced nothing new is the behavioural half of the contract.
  const last = run.passes[run.passes.length - 1]
  if (!last || last.newFindings !== 0) {
    return { state: TERMINAL.INCONCLUSIVE, reasons: ["no final complementary pass returned zero new findings"] }
  }

  return { state: TERMINAL.CLEAN, reasons: [] }
}
