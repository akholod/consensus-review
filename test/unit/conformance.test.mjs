// Asserts that contracts/loop-payload.schema.json and the runtime validators disagree in EXACTLY
// the ways the schema's "x-runtime" block declares, and nowhere else.
//
// This is the boundary that decides what is accepted: the runtime validator, not any document. It
// was completely unguarded before. The schema deliberately does not encode the semantic rules
// (non-blank after trimming, the P0/P1 bar) — see scripts/lib/json-schema.mjs — so they are
// asserted here against the functions that own them.
//
// Layers, per docs/eval-layer-plan.md §3.3:
//   1 structural  — the schema, and adapter.interpret
//   2 semantic    — validateFinding, validateEvidence (one record at a time)
//   3 contextual  — applyVerdicts, evidenceSubstantiates, runLoop (a whole run)

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { validate } from "../../scripts/lib/json-schema.mjs"
import { validateFinding, validateEvidence, evidenceSubstantiates, validAnchor } from "../../src/loop-review/schema.mjs"
import { interpret } from "../../src/loop-review/adapter.mjs"
import { applyVerdicts } from "../../src/loop-review/loop.mjs"

const ROOT = JSON.parse(readFileSync("contracts/loop-payload.schema.json", "utf8"))
const DECLARED = ROOT["x-runtime"]

const finding = (over = {}) => ({
  title: "t", file: "src/a.js", line: "1", severity: "P1", category: "correctness",
  rationale: "r", failure_scenario: "s", confidence: "high", suggested_fix: null, ...over,
})

const schemaAccepts = (value, entry) => validate(ROOT, value, entry).length === 0
const runtimeAcceptsFinding = (value) => validateFinding(value).length === 0

// ---------------------------------------------------------------------------------------------
// Layer 2 — findings. Each row states which side accepts, and which declared key explains it.
// `agree` rows are the important half: they prove the two are aligned everywhere not declared.
// ---------------------------------------------------------------------------------------------

const FINDING_CASES = [
  // --- must agree -----------------------------------------------------------------------------
  { why: "agree", accept: true, record: finding() },
  { why: "agree", accept: true, record: finding({ severity: "P2", failure_scenario: null }) },
  { why: "agree", accept: true, record: finding({ line: null, suggested_fix: "do x" }) },
  { why: "agree", accept: false, record: finding({ severity: "P3" }) },
  { why: "agree", accept: false, record: finding({ category: "invented" }) },
  { why: "agree", accept: false, record: finding({ confidence: "certain" }) },
  { why: "agree", accept: false, record: (() => { const f = finding(); delete f.line; return f })() },
  { why: "agree", accept: false, record: (() => { const f = finding(); delete f.severity; return f })() },
  { why: "agree", accept: false, record: finding({ title: 42 }) },
  { why: "agree", accept: false, record: finding({ line: true }) },

  // --- declared: runtime accepts MORE ---------------------------------------------------------
  { why: "numeric-nullable-fields", schema: false, runtime: true, record: finding({ line: 12 }) },
  // Only reachable at P2: the P0/P1 bar demands a non-blank STRING, so a number fails there for a
  // different reason. That interaction is recorded in the schema's declaration.
  { why: "numeric-nullable-fields", schema: false, runtime: true, record: finding({ severity: "P2", failure_scenario: 7 }) },
  { why: "numeric-nullable-fields", schema: false, runtime: true, record: finding({ suggested_fix: 7 }) },
  { why: "extra-finding-properties", schema: false, runtime: true, record: finding({ dimension: "impact" }) },
  { why: "extra-finding-properties", schema: false, runtime: true, record: finding({ owner: "tests" }) },

  // --- declared: runtime accepts LESS ---------------------------------------------------------
  { why: "non-blank-strings", schema: true, runtime: false, record: finding({ title: "" }) },
  { why: "non-blank-strings", schema: true, runtime: false, record: finding({ title: "   " }) },
  { why: "non-blank-strings", schema: true, runtime: false, record: finding({ file: "" }) },
  { why: "non-blank-strings", schema: true, runtime: false, record: finding({ rationale: "\t\n" }) },
  { why: "actionable-needs-scenario", schema: true, runtime: false, record: finding({ severity: "P0", failure_scenario: null }) },
  { why: "actionable-needs-scenario", schema: true, runtime: false, record: finding({ severity: "P1", failure_scenario: "  " }) },
]

for (const [i, row] of FINDING_CASES.entries()) {
  test(`layer 2 finding #${i} (${row.why})`, () => {
    const s = schemaAccepts(row.record, "#/$defs/loopFinding")
    const r = runtimeAcceptsFinding(row.record)
    if (row.why === "agree") {
      assert.equal(s, row.accept, `schema should ${row.accept ? "accept" : "reject"} ${JSON.stringify(row.record)}`)
      assert.equal(r, row.accept, `runtime should ${row.accept ? "accept" : "reject"} ${JSON.stringify(row.record)}`)
      return
    }
    assert.equal(s, row.schema, `schema verdict changed for a declared disagreement (${row.why})`)
    assert.equal(r, row.runtime, `runtime verdict changed for a declared disagreement (${row.why})`)
    assert.notEqual(s, r, `${row.why} is declared a disagreement but the two now agree — update x-runtime`)
  })
}

test("every declared finding disagreement is exercised by a case above", () => {
  const declared = [...Object.keys(DECLARED.tolerates), ...Object.keys(DECLARED.requires)]
    .filter((k) => k !== "note")
    // These two are not finding-level; they are covered by their own tests below.
    .filter((k) => k !== "uncovered-cell-omissions" && k !== "absent-verifier-arrays" && k !== "covered-cell-substance")
  const exercised = new Set(FINDING_CASES.map((c) => c.why))
  for (const key of declared) {
    assert.ok(exercised.has(key), `x-runtime declares "${key}" but no conformance case exercises it`)
  }
})

test("no undeclared disagreement hides in the enum and required surface", () => {
  // Sweep every enum member and every single-key omission. Anything that disagrees here without a
  // declared reason is drift.
  const enums = {
    severity: ["P0", "P1", "P2"],
    category: ["security", "correctness", "perf", "maintainability", "tests", "style"],
    confidence: ["low", "medium", "high"],
  }
  for (const [field, members] of Object.entries(enums)) {
    for (const member of members) {
      // P0/P1 need a scenario, which is a declared narrowing — give them one so this sweep is
      // testing the enum surface and not re-testing that rule.
      const record = finding({ [field]: member, failure_scenario: "concrete scenario" })
      assert.equal(
        schemaAccepts(record, "#/$defs/loopFinding"),
        runtimeAcceptsFinding(record),
        `undeclared disagreement on ${field}=${member}`
      )
    }
  }
  for (const key of Object.keys(finding())) {
    const record = finding()
    delete record[key]
    assert.equal(
      schemaAccepts(record, "#/$defs/loopFinding"),
      runtimeAcceptsFinding(record),
      `undeclared disagreement when "${key}" is absent`
    )
  }
})

// ---------------------------------------------------------------------------------------------
// Layer 2 — evidence. validateEvidence reads cell.files and cell.maxLine, which are OUTSIDE the
// record, so JSON Schema cannot express the anchor rule at any cost. The schema states the record's
// shape; the cross-object rule is a hand-written table against a canonical cell.
// ---------------------------------------------------------------------------------------------

const CELL = Object.freeze({ id: "source:security", files: ["src/a.js"], maxLine: { "src/a.js": 40 } })

const record = (over = {}) => ({
  cell: "source:security", status: "covered", anchors: ["src/a.js:10"], checks: ["read the guard"],
  context_used: "the diff hunk", disposition: "none", context_complete: true, ...over,
})

test("layer 2 evidence: schema and runtime agree on the record's shape", () => {
  for (const r of [record(), record({ disposition: "reported" }), record({ context_complete: false })]) {
    assert.ok(schemaAccepts(r, "#/$defs/evidenceRecord"), JSON.stringify(r))
    assert.deepEqual(validateEvidence(r, CELL), [])
  }
  for (const r of [record({ status: "maybe" }), record({ anchors: "src/a.js:10" }), record({ context_complete: "yes" })]) {
    assert.ok(!schemaAccepts(r, "#/$defs/evidenceRecord"), JSON.stringify(r))
    assert.ok(validateEvidence(r, CELL).length > 0, JSON.stringify(r))
  }
})

test("layer 2 evidence: uncovered-cell-omissions is a declared tolerance", () => {
  const r = record({ status: "uncovered", anchors: [], checks: [] })
  delete r.context_used
  delete r.disposition
  assert.ok(!schemaAccepts(r, "#/$defs/evidenceRecord"), "the schema requires them, as the prompt asks")
  assert.deepEqual(validateEvidence(r, CELL), [], "the runtime requires them only for a covered cell")
})

test("layer 2 evidence: the anchor rule is not expressible in the schema, so it is asserted here", () => {
  // Every one of these is schema-valid and runtime-rejected: the rule reads the cell, not the record.
  const anchorCases = [
    { anchors: ["other/file.js:10"], why: "anchor names a file outside the cell" },
    { anchors: ["src/a.js:41"], why: "anchor exceeds the file's line bound" },
    { anchors: ["src/a.js:0"], why: "line 0 is not a location" },
    { anchors: ["src/a.js:30-41"], why: "range end exceeds the bound" },
    { anchors: ["src/a.js"], why: "no line, and the cell has a bound" },
    { anchors: [""], why: "blank anchor" },
  ]
  for (const c of anchorCases) {
    const r = record({ anchors: c.anchors })
    assert.ok(schemaAccepts(r, "#/$defs/evidenceRecord"), `${c.why}: should be schema-valid`)
    assert.ok(validateEvidence(r, CELL).length > 0, `${c.why}: runtime should reject`)
  }
  // Accepted forms, for the other direction.
  for (const anchors of [["src/a.js:1"], ["src/a.js:10-20"], ["src/a.js:40"], ["a.js:10"]]) {
    assert.deepEqual(validateEvidence(record({ anchors }), CELL), [], anchors.join())
  }
  assert.equal(validAnchor("src/a.js:41", CELL), false)
  assert.equal(validAnchor("src/a.js:40", CELL), true)
})

test("layer 2 evidence: covered-cell-substance is a declared narrowing", () => {
  for (const r of [record({ anchors: [] }), record({ checks: [] }), record({ context_used: "  " })]) {
    assert.ok(schemaAccepts(r, "#/$defs/evidenceRecord"), JSON.stringify(r))
    assert.ok(validateEvidence(r, CELL).length > 0, JSON.stringify(r))
  }
})

// ---------------------------------------------------------------------------------------------
// Layer 1 — the adapter. Structural, and it FAILS THE PASS rather than skipping anything.
// ---------------------------------------------------------------------------------------------

const envelope = (payload) => JSON.stringify({
  is_error: false, subtype: "success", stop_reason: "end_turn", usage: {},
  result: JSON.stringify(payload),
})

test("layer 1: the adapter rejects a missing array, a non-object member, and missing cells", () => {
  const okPayload = { findings: [], cells: [] }
  assert.equal(interpret({ rc: 0, stdout: envelope(okPayload), timedOut: false }).state, "ok")

  // Not "silently skipped" — the whole pass is malformed and nothing is applied.
  assert.equal(interpret({ rc: 0, stdout: envelope({ cells: [] }), timedOut: false }).state, "malformed")
  assert.equal(interpret({ rc: 0, stdout: envelope({ findings: [null], cells: [] }), timedOut: false }).state, "malformed")
  assert.equal(interpret({ rc: 0, stdout: envelope({ findings: [[]], cells: [] }), timedOut: false }).state, "malformed")
  assert.equal(interpret({ rc: 0, stdout: envelope({ findings: [] }), timedOut: false }).state, "malformed")

  // The verifier entrypoint keys off `verdicts`, and does NOT require `cell_verdicts`.
  const asVerifier = (p) => interpret({ rc: 0, stdout: envelope(p), timedOut: false, requireKey: "verdicts" })
  assert.equal(asVerifier({ verdicts: [] }).state, "ok")
  assert.equal(asVerifier({ verdicts: [3] }).state, "malformed")
  assert.equal(asVerifier({ cell_verdicts: [] }).state, "malformed")
})

// ---------------------------------------------------------------------------------------------
// Layer 3 — contextual. Every rule here is a SILENT SKIP whose consequence is that the finding
// stays unadjudicated and escalates. That is the false-CLEAN hazard class, and no schema can hold
// any of it: the rules refer to ids issued this batch and evidence supplied on an earlier pass.
// ---------------------------------------------------------------------------------------------

const runWith = (over = {}) => ({
  findings: [{ fingerprint: "fp1", file: "src/a.js", severity: "P1", title: "t", verdict: null }],
  refuted: [], cells: [], ...over,
})

const grounded = "traced the request path in src/a.js and found no other guard"

test("layer 3: a verdict is applied only when its evidence names the finding's file", () => {
  const run = runWith()
  applyVerdicts(run, [{ id: "fp1", verdict: "confirmed", evidence: grounded }])
  assert.equal(run.findings[0].verdict, "confirmed")

  // Ungrounded: long enough, but names nothing in the code.
  const skipped = runWith()
  applyVerdicts(skipped, [{ id: "fp1", verdict: "confirmed", evidence: "this is definitely a real issue, trust me" }])
  assert.equal(skipped.findings[0].verdict, null, "ungrounded evidence must be skipped, not applied")

  // Too short, even though it names the file.
  const short = runWith()
  applyVerdicts(short, [{ id: "fp1", verdict: "refuted", evidence: "src/a.js" }])
  assert.equal(short.findings[0].verdict, null)
  assert.deepEqual(short.refuted, [], "a refutation must never land on evidence this thin")
})

test("layer 3: evidenceSubstantiates accepts a path, a basename and a matching suffix", () => {
  const pad = "x".repeat(25)
  assert.equal(evidenceSubstantiates(`${pad} src/a.js`, "src/a.js"), true, "full path")
  assert.equal(evidenceSubstantiates(`${pad} a.js`, "src/a.js"), true, "basename")
  assert.equal(evidenceSubstantiates(`${pad} src/a.js:12`, "src/a.js"), true, "path with a location")
  assert.equal(evidenceSubstantiates(`${pad} deep/src/a.js`, "repo/deep/src/a.js"), true, "matching suffix")
  assert.equal(evidenceSubstantiates(`${pad} other-a.js`, "src/a.js"), false, "a near-miss is not a citation")
  assert.equal(evidenceSubstantiates("src/a.js", "src/a.js"), false, "under 20 characters")
  assert.equal(evidenceSubstantiates(null, "src/a.js"), false)
})

test("layer 3: an unconfirmed verdict needs no grounding, because it changes nothing", () => {
  const run = runWith()
  applyVerdicts(run, [{ id: "fp1", verdict: "unconfirmed", evidence: "could not tell" }])
  assert.equal(run.findings[0].verdict, "unconfirmed")
})

test("layer 3: a verdict naming no known finding is dropped", () => {
  const run = runWith()
  applyVerdicts(run, [{ id: "not-a-fingerprint", verdict: "confirmed", evidence: grounded }])
  assert.equal(run.findings[0].verdict, null)
})

test("layer 3: a non-object verdict is skipped without throwing", () => {
  const run = runWith()
  applyVerdicts(run, [null, 7, "x", []])
  assert.equal(run.findings[0].verdict, null)
})
