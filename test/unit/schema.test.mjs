import { test } from "node:test"
import assert from "node:assert/strict"
import {
  TERMINAL, PASS_STATE, PASS_POLICY, HIGH_RISK, RISK, SURFACE,
  normalizeVerdict, makeCell, validateEvidence, validateFinding,
  fingerprint, minimumPasses, newRunState, budgetExhausted, isStale, evaluateTerminal,
} from "../../src/loop-review/schema.mjs"

const cell = (surface, risk) => makeCell(surface, risk, ["a.js"])

function runWith(overrides = {}) {
  const run = newRunState({
    target: "worktree",
    diffHash: "h1",
    cells: [cell(SURFACE.SOURCE, RISK.CORRECTNESS)],
    trivial: false,
    highRisk: false,
    budget: { tokens: 0, calls: 0, ms: 0 },
  })
  run.cells.forEach((c) => { c.covered = true; c.verifiedIndependently = true })
  run.passes = [
    { state: PASS_STATE.OK, newFindings: 1 },
    { state: PASS_STATE.OK, newFindings: 0 },
  ]
  return Object.assign(run, overrides)
}

test("pass policy matches the accepted baseline", () => {
  assert.equal(minimumPasses({ trivial: true }), 0)
  assert.equal(minimumPasses({ trivial: false, highRisk: false }), 2)
  assert.equal(minimumPasses({ trivial: false, highRisk: true }), 3)
  assert.equal(PASS_POLICY.HARD_MAX, 4)
  assert.equal(PASS_POLICY.LIGHTWEIGHT_MAX, 1)
})

test("high-risk categories are the ones whose failure does not scale with size", () => {
  assert.deepEqual([...HIGH_RISK].sort(), [RISK.CONTRACT, RISK.DATA, RISK.SECURITY].sort())
  assert.equal(makeCell(SURFACE.MIGRATION, RISK.DATA, []).mandatory, true)
  assert.equal(makeCell(SURFACE.SOURCE, RISK.CORRECTNESS, []).mandatory, false)
})

test("reduced is derived from confirmed plus a lower suggested severity, never emitted directly", () => {
  assert.deepEqual(normalizeVerdict("confirmed", "P0", "P2"), { verdict: "reduced", reduced: true })
  assert.deepEqual(normalizeVerdict("confirmed", "P1", "P1"), { verdict: "confirmed", reduced: false })
  assert.deepEqual(normalizeVerdict("confirmed", "P2", "P0"), { verdict: "confirmed", reduced: false })
  assert.deepEqual(normalizeVerdict("refuted", "P0", null), { verdict: "refuted", reduced: false })
  // an unknown verdict must fall back to the sceptical side, never to confirmed
  assert.equal(normalizeVerdict("reduced", "P0", null).verdict, "unconfirmed")
})

test("P0/P1 require a concrete failure scenario", () => {
  const base = {
    title: "t", file: "a.js", rationale: "r", severity: "P1",
    category: "correctness", confidence: "high", line: null, failure_scenario: null, suggested_fix: null,
  }
  assert.ok(validateFinding(base).some((p) => /failure_scenario/.test(p)))
  assert.deepEqual(validateFinding({ ...base, failure_scenario: "x triggers y" }), [])
  assert.deepEqual(validateFinding({ ...base, severity: "P2" }), [])
  // every contracted key must be present, nullable ones explicitly so
  const { suggested_fix, ...missingFix } = base
  assert.ok(validateFinding(missingFix).some((p) => /missing suggested_fix/.test(p)))
})

test("a covered cell with no anchors or checks is not coverage", () => {
  const cell = { ...makeCell(SURFACE.SOURCE, RISK.CORRECTNESS, ["a.js"]), maxLine: { "a.js": 40 } }
  const bad = { cell: cell.id, status: "covered", anchors: [], checks: [], context_used: "the diff", disposition: "none", context_complete: true }
  const problems = validateEvidence(bad, cell)
  assert.ok(problems.some((p) => /anchors/.test(p)))
  assert.ok(problems.some((p) => /checks/.test(p)))
  const good = { ...bad, anchors: ["a.js:10"], checks: ["read the guard"] }
  assert.deepEqual(validateEvidence(good, cell), [])
  assert.ok(validateEvidence(null, cell).length)
})

test("fingerprints derive from structured fields only", () => {
  const fp = fingerprint({ file: "a.js", line: 10, category: "security", title: "  Missing   guard  " })
  assert.equal(fp, "a.js:10:security:Missing guard")
  assert.equal(fingerprint({ file: "a.js", line: null, title: "x" }), "a.js:-:uncategorised:x")
})

test("CLEAN requires the full conjunction", () => {
  assert.equal(evaluateTerminal(runWith(), "h1").state, TERMINAL.CLEAN)
})

test("a stale diff can never be CLEAN", () => {
  const r = evaluateTerminal(runWith(), "h2")
  assert.equal(r.state, TERMINAL.INCONCLUSIVE)
  assert.match(r.reasons[0], /stale/)
})

test("too few passes can never be CLEAN", () => {
  const run = runWith({ passes: [{ state: PASS_STATE.OK, newFindings: 0 }] })
  const r = evaluateTerminal(run, "h1")
  assert.equal(r.state, TERMINAL.INCONCLUSIVE)
  assert.ok(r.reasons.some((x) => /required passes/.test(x)))
})

test("an uncovered mandatory cell can never be CLEAN", () => {
  const run = runWith()
  run.cells.push({ ...makeCell(SURFACE.MIGRATION, RISK.DATA, ["m.sql"]), covered: false, verifiedIndependently: false })
  const r = evaluateTerminal(run, "h1")
  assert.equal(r.state, TERMINAL.INCONCLUSIVE)
  assert.ok(r.reasons.some((x) => /cell\(s\) uncovered/.test(x) && /mandatory/.test(x)))
})

test("a high-risk cell without independent verification can never be CLEAN", () => {
  const run = runWith()
  run.cells.push({ ...makeCell(SURFACE.MIGRATION, RISK.DATA, ["m.sql"]), covered: true, verifiedIndependently: false })
  const r = evaluateTerminal(run, "h1")
  assert.equal(r.state, TERMINAL.INCONCLUSIVE)
  assert.ok(r.reasons.some((x) => /independent verification/.test(x)))
})

test("no final zero-yield pass means not CLEAN", () => {
  const run = runWith({ passes: [{ state: PASS_STATE.OK, newFindings: 1 }, { state: PASS_STATE.OK, newFindings: 2 }] })
  const r = evaluateTerminal(run, "h1")
  assert.equal(r.state, TERMINAL.INCONCLUSIVE)
  assert.ok(r.reasons.some((x) => /complementary pass/.test(x)))
})

test("exhausted budget can never be CLEAN", () => {
  const run = runWith()
  run.budget.tokens = 100
  run.spent.tokens = 100
  assert.equal(budgetExhausted(run), true)
  assert.equal(evaluateTerminal(run, "h1").state, TERMINAL.INCONCLUSIVE)
})

test("confirmed findings produce FINDINGS, and escalation outranks them", () => {
  const run = runWith()
  run.findings = [{ verdict: "confirmed" }]
  assert.equal(evaluateTerminal(run, "h1").state, TERMINAL.FINDINGS)
  run.escalations = ["suspected P0 with incomplete context"]
  assert.equal(evaluateTerminal(run, "h1").state, TERMINAL.ESCALATE)
})

test("exceeding the pass ceiling escalates", () => {
  const run = runWith({ passes: Array(5).fill({ state: PASS_STATE.OK, newFindings: 0 }) })
  assert.equal(evaluateTerminal(run, "h1").state, TERMINAL.ESCALATE)
})

test("isStale compares the recorded snapshot", () => {
  assert.equal(isStale(runWith(), "h1"), false)
  assert.equal(isStale(runWith(), "other"), true)
})

test("parseAnchor accepts a bare path, a line, and a line range", async () => {
  const { parseAnchor } = await import("../../src/loop-review/schema.mjs")
  assert.deepEqual(parseAnchor("src/a.js"), { path: "src/a.js", line: null })
  assert.deepEqual(parseAnchor("src/a.js:12"), { path: "src/a.js", line: 12, lineEnd: 12 })
  assert.deepEqual(parseAnchor("src/a.js:12-18"), { path: "src/a.js", line: 12, lineEnd: 18 })
  // Not a location: the whole string is treated as a path, which will then fail the file check.
  assert.deepEqual(parseAnchor("src/a.js:somewhere"), { path: "src/a.js:somewhere", line: null })
})

test("a line range is checked against the file bound, not just its start", () => {
  const cell = { ...makeCell(SURFACE.SOURCE, RISK.CORRECTNESS, ["a.js"]), maxLine: { "a.js": 40 } }
  const rec = (anchor) => ({ cell: cell.id, status: "covered", anchors: [anchor], checks: ["c"], context_used: "diff", disposition: "none", context_complete: true })
  assert.deepEqual(validateEvidence(rec("a.js:1-20"), cell), [])
  assert.ok(validateEvidence(rec("a.js:1-99999"), cell).some((p) => /inspectable location/.test(p)))
})

test("evidence naming a different file does not substantiate a finding", async () => {
  const { evidenceSubstantiates } = await import("../../src/loop-review/schema.mjs")
  assert.equal(evidenceSubstantiates("I checked other-schema.mjs and it is fine here", "src/schema.mjs"), false)
  assert.equal(evidenceSubstantiates("I checked src/schema.mjs line 10 and the guard is gone", "src/schema.mjs"), true)
  assert.equal(evidenceSubstantiates("I checked schema.mjs line 10 and the guard is gone", "src/schema.mjs"), true)
  assert.equal(evidenceSubstantiates("not a real issue", "src/schema.mjs"), false)
})

test("a reversed line range is not a location", async () => {
  const { parseAnchor } = await import("../../src/loop-review/schema.mjs")
  assert.equal(parseAnchor("a.js:20-10").line, null)
  assert.equal(parseAnchor("a.js:10-20").line, 10)
})

test("a citation carrying a line number still names its file", async () => {
  const { evidenceSubstantiates } = await import("../../src/loop-review/schema.mjs")
  assert.equal(evidenceSubstantiates("checked src/auth/guard.js:2 and the guard is gone", "src/auth/guard.js"), true)
  assert.equal(evidenceSubstantiates("checked guard.js:2-5 and the guard is gone", "src/auth/guard.js"), true)
  assert.equal(evidenceSubstantiates("checked other-guard.js:2 and it is fine here", "src/auth/guard.js"), false)
})

test("a file with nothing inspectable cannot be anchored at all", async () => {
  const { validAnchor } = await import("../../src/loop-review/schema.mjs")
  const binary = { files: ["logo.png"], maxLine: { "logo.png": 0 } }
  assert.equal(validAnchor("logo.png", binary), false, "a bare path must not cover a binary file")
  assert.equal(validAnchor("logo.png:1", binary), false)
  const text = { files: ["a.js"], maxLine: { "a.js": 10 } }
  assert.equal(validAnchor("a.js:5", text), true)
  assert.equal(validAnchor("a.js:11", text), false)
  assert.equal(validAnchor("a.js", text), false, "covered evidence must cite a location")
})

test("malformed evidence fields are rejected, never crash the runtime", () => {
  const cell = { ...makeCell(SURFACE.SOURCE, RISK.CORRECTNESS, ["a.js"]), maxLine: { "a.js": 10 } }
  const base = { cell: cell.id, status: "covered", context_used: "diff", disposition: "none", context_complete: true }
  for (const broken of [
    { ...base, anchors: "a.js:1", checks: ["c"] },
    { ...base, anchors: ["a.js:1"], checks: "looked" },
    { ...base, anchors: null, checks: null },
    { ...base, anchors: { 0: "a.js:1" }, checks: ["c"] },
  ]) {
    const problems = validateEvidence(broken, cell)
    assert.ok(problems.length, `${JSON.stringify(broken.anchors)} must be rejected`)
  }
})

test("evidence admission and approval share one definition of a valid anchor", async () => {
  const { validAnchor } = await import("../../src/loop-review/schema.mjs")
  // With no files recorded for the cell, an invented path must fail both paths alike.
  const empty = { ...makeCell(SURFACE.SOURCE, RISK.CORRECTNESS, []), maxLine: {} }
  assert.equal(validAnchor("invented.js:1", empty), false)
  const rec = { cell: empty.id, status: "covered", anchors: ["invented.js:1"], checks: ["c"], context_used: "diff", disposition: "none", context_complete: true }
  assert.ok(validateEvidence(rec, empty).some((p) => /inspectable location/.test(p)))
})

test("findings with wrong-typed or unknown-valued fields are rejected", () => {
  const base = {
    title: "t", file: "a.js", rationale: "r", severity: "P2",
    category: "correctness", confidence: "high", line: null, failure_scenario: null, suggested_fix: null,
  }
  assert.deepEqual(validateFinding(base), [])
  assert.ok(validateFinding({ ...base, category: "vibes" }).some((p) => /category/.test(p)))
  assert.ok(validateFinding({ ...base, confidence: "absolute" }).some((p) => /confidence/.test(p)))
  assert.ok(validateFinding({ ...base, line: { n: 1 } }).some((p) => /line/.test(p)))
  assert.ok(validateFinding({ ...base, suggested_fix: ["do it"] }).some((p) => /suggested_fix/.test(p)))
  // a non-string failure_scenario must not satisfy the P0/P1 bar merely by being present
  assert.ok(validateFinding({ ...base, severity: "P0", failure_scenario: true }).some((p) => /failure_scenario/.test(p)))
  assert.deepEqual(validateFinding({ ...base, severity: "P0", failure_scenario: "x causes y" }), [])
})
