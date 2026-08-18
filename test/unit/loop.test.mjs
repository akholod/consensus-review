import { test } from "node:test"
import assert from "node:assert/strict"
import {
  buildNegativeSpace, renderNegativeSpace, buildPassPrompt,
  applyPass, applyVerdicts, shouldContinue, spend, runLoop,
} from "../../src/loop-review/loop.mjs"
import { newRunState, makeCell, SURFACE, RISK, TERMINAL, PASS_STATE } from "../../src/loop-review/schema.mjs"
import { honestVerifier, cellsOnlyVerifier } from "../../testkit/helpers.mjs"

const cells = () => [makeCell(SURFACE.SOURCE, RISK.CORRECTNESS, ["a.js"])]
const mandatoryCells = () => [
  makeCell(SURFACE.SOURCE, RISK.CORRECTNESS, ["a.js"]),
  makeCell(SURFACE.MIGRATION, RISK.DATA, ["1.sql"]),
]

const mkRun = (opts = {}) =>
  newRunState({ target: "t", diffHash: "h", cells: cells(), trivial: false, highRisk: false, budget: {}, ...opts })

const goodFinding = {
  title: "Guard removed", file: "a.js", line: "10", severity: "P1",
  category: "correctness", rationale: "why", failure_scenario: "unpaid order refunds",
  confidence: "high", suggested_fix: null,
}
const evidence = (id, status = "covered", file = "a.js") => ({
  cell: id, status, anchors: [`${file}:10`], checks: ["read the guard"],
  context_used: "the diff hunk for this file", disposition: "none", context_complete: true,
})

test("the negative-space payload carries only fingerprints, refuted claims and open cells", () => {
  const run = mkRun()
  run.findings = [{ fingerprint: "a.js:10:correctness:Guard removed", rationale: "SECRET REASONING", title: "Guard removed" }]
  run.refuted = ["b.js:1:perf:Slow loop"]
  const ns = buildNegativeSpace(run)
  assert.deepEqual(Object.keys(ns).sort(), ["already_reported", "refuted", "uncovered_cells"])
  const serialised = JSON.stringify(ns)
  assert.ok(!serialised.includes("SECRET REASONING"), "prior rationale must not cross the boundary")
})

test("the rendered handoff never contains the prior pass's reasoning", () => {
  const run = mkRun()
  run.findings = [{ fingerprint: "a.js:10:correctness:Guard removed", rationale: "because the guard protects refunds" }]
  const text = renderNegativeSpace(buildNegativeSpace(run))
  assert.match(text, /a\.js:10:correctness:Guard removed/)
  assert.ok(!text.includes("because the guard protects refunds"))
})

test("the static prefix stays first and byte-identical while the tail varies", () => {
  const prefix = "<review_context>STATIC</review_context>"
  const run = mkRun()
  const first = buildPassPrompt({ staticPrefix: prefix, instructions: "INSTR", negativeSpace: buildNegativeSpace(run) })
  run.findings = [{ fingerprint: "a.js:1:correctness:x" }]
  const second = buildPassPrompt({ staticPrefix: prefix, instructions: "INSTR", negativeSpace: buildNegativeSpace(run) })
  assert.ok(first.startsWith(prefix))
  assert.ok(second.startsWith(prefix))
  assert.notEqual(first, second)
})

test("applyPass records valid findings once and dedupes by fingerprint", () => {
  const run = mkRun()
  const pass = { index: 1 }
  const added = applyPass(run, pass, { findings: [goodFinding, { ...goodFinding }], cells: [] })
  assert.equal(added, 1)
  assert.equal(pass.newFindings, 1)
})

test("a P1 without a failure scenario is kept as unverified, never as a graded finding", () => {
  const run = mkRun()
  applyPass(run, { index: 1 }, { findings: [{ ...goodFinding, failure_scenario: null }], cells: [] })
  assert.equal(run.findings.length, 1)
  assert.equal(run.findings[0].unverified, true)
  assert.equal(run.findings[0].verdict, "unconfirmed")
})

test("dispatch is not coverage: evidence with no anchors is rejected", () => {
  const run = mkRun()
  applyPass(run, { index: 1 }, { findings: [], cells: [{ ...evidence("source:correctness"), anchors: [] }] })
  assert.equal(run.cells[0].covered, false)
  assert.ok(run.cells[0].evidence.rejected.some((p) => /anchors/.test(p)))
})

test("valid evidence marks the cell covered", () => {
  const run = mkRun()
  applyPass(run, { index: 1 }, { findings: [], cells: [evidence("source:correctness")] })
  assert.equal(run.cells[0].covered, true)
})

test("incomplete context on a mandatory cell escalates", () => {
  const run = mkRun({ cells: mandatoryCells(), highRisk: true })
  applyPass(run, { index: 1 }, {
    findings: [],
    cells: [{ ...evidence("migration:data", "covered", "1.sql"), context_complete: false }],
  })
  assert.ok(run.escalations.some((e) => /incomplete context/.test(e)))
})

test("verdicts normalise, and unadjudicated findings never become facts", () => {
  const run = mkRun()
  applyPass(run, { index: 1 }, { findings: [goodFinding], cells: [] })
  const fp = run.findings[0].fingerprint
  applyVerdicts(run, [{ id: fp, verdict: "confirmed", suggested_severity: "P2", evidence: "traced a concrete path through a.js line 10" }])
  assert.equal(run.findings[0].verdict, "reduced")
  assert.equal(run.findings[0].severity, "P2")

  // applyVerdicts no longer defaults a pending verdict: leaving it null is what lets runLoop
  // tell "never adjudicated" apart from "adjudicated as unconfirmed" and escalate on the former.
  const run2 = mkRun()
  applyPass(run2, { index: 1 }, { findings: [goodFinding], cells: [] })
  applyVerdicts(run2, [])
  assert.equal(run2.findings[0].verdict, null)
})

test("a refuted finding is remembered so a later pass cannot resurrect it", () => {
  const run = mkRun()
  applyPass(run, { index: 1 }, { findings: [goodFinding], cells: [] })
  applyVerdicts(run, [{ id: run.findings[0].fingerprint, verdict: "refuted", evidence: "already guarded upstream in a.js before this call" }])
  assert.deepEqual(run.refuted, ["a.js:10:correctness:Guard removed"])
  assert.ok(renderNegativeSpace(buildNegativeSpace(run)).includes("<refuted>"))
})

test("shouldContinue honours the minimum, the ceiling and open mandatory cells", () => {
  const run = mkRun()
  assert.equal(shouldContinue(run), true, "below the minimum it is mandatory")
  run.passes = [{ state: PASS_STATE.OK, newFindings: 0 }, { state: PASS_STATE.OK, newFindings: 0 }]
  run.cells[0].covered = true
  assert.equal(shouldContinue(run), false, "minimum met, nothing new, nothing open")
  run.passes[1].newFindings = 1
  assert.equal(shouldContinue(run), true, "the last pass still found something")
  run.passes = Array(4).fill({ state: PASS_STATE.OK, newFindings: 1 })
  assert.equal(shouldContinue(run), false, "the hard ceiling wins over new findings")
})

test("an exhausted budget stops the loop", () => {
  const run = mkRun({ budget: { tokens: 10, calls: 0, ms: 0 } })
  spend(run, { input_tokens: 20, output_tokens: 0 }, 5)
  assert.equal(shouldContinue(run), false)
})

// ---- end-to-end over stubbed runners -------------------------------------------------

const ctxFor = (over = {}) => ({
  target: "t", diffHash: "h", cells: cells(), trivial: false, highRisk: false,
  staticPrefix: "<review_context>S</review_context>", ...over,
})
const okPass = (payload) => ({ state: PASS_STATE.OK, payload, usage: {}, ms: 1, detail: "" })
const cleanPayload = (ids) => ({ findings: [], cells: ids.map((id) => evidence(id)) })

test("a non-trivial diff runs at least two passes", async () => {
  let calls = 0
  const run = await runLoop({
    ctx: ctxFor(),
    runner: async () => { calls++; return okPass(cleanPayload(["source:correctness"])) },
    verifier: async () => [],
    currentDiffHash: "h",
  })
  assert.ok(calls >= 2, `expected >= 2 passes, got ${calls}`)
  assert.equal(run.terminal, TERMINAL.CLEAN)
})

test("a high-risk diff runs at least three passes", async () => {
  let calls = 0
  const run = await runLoop({
    ctx: ctxFor({ cells: mandatoryCells(), highRisk: true }),
    runner: async () => { calls++; return okPass(cleanPayload(["source:correctness", "migration:data"])) },
    verifier: async () => [],
    currentDiffHash: "h",
  })
  assert.ok(calls >= 3, `expected >= 3 passes, got ${calls}`)
  assert.equal(run.minPasses, 3)
})

test("the loop never exceeds the hard ceiling of four passes", async () => {
  let calls = 0
  const run = await runLoop({
    ctx: ctxFor({ cells: mandatoryCells(), highRisk: true }),
    // every pass keeps finding something new, so only the ceiling can stop it
    runner: async () => {
      calls++
      return okPass({ findings: [{ ...goodFinding, title: `Finding ${calls}` }], cells: [] })
    },
    verifier: async () => [],
    currentDiffHash: "h",
  })
  assert.equal(calls, 4)
  assert.ok(run.passes.length <= 4)
})

test("a runner failure blocks CLEAN and escalates", async () => {
  const run = await runLoop({
    ctx: ctxFor(),
    runner: async () => ({ state: PASS_STATE.TIMEOUT, payload: null, usage: {}, ms: 1, detail: "timed out" }),
    verifier: async () => [],
    currentDiffHash: "h",
  })
  assert.notEqual(run.terminal, TERMINAL.CLEAN)
  assert.equal(run.terminal, TERMINAL.ESCALATE)
})

test("a diff that moves during the run is INCONCLUSIVE, never CLEAN", async () => {
  const run = await runLoop({
    ctx: ctxFor(),
    runner: async () => okPass(cleanPayload(["source:correctness"])),
    verifier: async () => [],
    currentDiffHash: "MOVED",
  })
  assert.equal(run.terminal, TERMINAL.INCONCLUSIVE)
  assert.match(run.terminalReasons.join(" "), /stale/)
})

test("an uncovered mandatory cell exhausts the loop and escalates, never CLEAN", async () => {
  const run = await runLoop({
    ctx: ctxFor({ cells: mandatoryCells(), highRisk: true }),
    runner: async () => okPass(cleanPayload(["source:correctness"])), // migration:data never covered
    verifier: cellsOnlyVerifier,
    currentDiffHash: "h",
  })
  assert.notEqual(run.terminal, TERMINAL.CLEAN)
  assert.equal(run.terminal, TERMINAL.ESCALATE)
  assert.match(run.terminalReasons.join(" "), /migration:data/)
  assert.equal(run.passes.length, 4, "it should keep trying until the ceiling")
})

test("a trivial diff takes at most one lightweight pass", async () => {
  let calls = 0
  const run = await runLoop({
    ctx: ctxFor({ cells: [], trivial: true }),
    runner: async () => { calls++; return okPass({ findings: [], cells: [] }) },
    verifier: async () => [],
    currentDiffHash: "h",
  })
  assert.equal(calls, 1)
  assert.equal(run.maxPasses, 1)
})

test("confirmed findings end the run in FINDINGS", async () => {
  let n = 0
  const run = await runLoop({
    ctx: ctxFor(),
    runner: async () => {
      n++
      return okPass(n === 1
        ? { findings: [goodFinding], cells: [evidence("source:correctness")] }
        : { findings: [], cells: [evidence("source:correctness")] })
    },
    verifier: honestVerifier,
    currentDiffHash: "h",
  })
  assert.equal(run.terminal, TERMINAL.FINDINGS)
})

test("a P2 that cleared the admission bar blocks CLEAN even though P2s are never verified", async () => {
  // Regression guard: P2 findings are deliberately not sent to the adversarial verifier, so they
  // never receive a verdict. Counting only verified findings made a real P2 invisible and let the
  // run report CLEAN with a finding standing.
  const p2 = {
    title: "Parse failure swallowed", file: "io.js", line: "4", severity: "P2",
    category: "maintainability", rationale: "returns {} on any failure, unlike every other loader here",
    failure_scenario: null, confidence: "medium", suggested_fix: null,
  }
  let n = 0
  const run = await runLoop({
    ctx: ctxFor(),
    runner: async () => {
      n++
      return okPass(n === 1
        ? { findings: [p2], cells: [evidence("source:correctness")] }
        : { findings: [], cells: [evidence("source:correctness")] })
    },
    verifier: async ({ findings }) => {
      assert.equal(findings.length, 0, "P2 must not be sent for adversarial verification")
      return []
    },
    currentDiffHash: "h",
  })
  assert.equal(run.terminal, TERMINAL.FINDINGS)
})

test("a verifier that adjudicates nothing can never yield CLEAN", async () => {
  // Regression guard, found by a live run: the verifier returned an unparseable payload, so the
  // loop applied zero verdicts, the P0 fell to `unconfirmed`, and the run reported CLEAN with the
  // authorization check still removed.
  let n = 0
  const run = await runLoop({
    ctx: ctxFor(),
    runner: async () => {
      n++
      return okPass(n === 1
        ? { findings: [{ ...goodFinding, severity: "P0", title: "Ownership check removed" }], cells: [evidence("source:correctness")] }
        : { findings: [], cells: [evidence("source:correctness")] })
    },
    verifier: async () => [], // verification failed / returned nothing
    currentDiffHash: "h",
  })
  assert.notEqual(run.terminal, TERMINAL.CLEAN)
  assert.equal(run.terminal, TERMINAL.ESCALATE)
  assert.match(run.escalations.join(" "), /never resolved by verification/)
})

test("actionable findings with no verifier at all escalate", async () => {
  let n = 0
  const run = await runLoop({
    ctx: ctxFor(),
    runner: async () => {
      n++
      return okPass(n === 1
        ? { findings: [{ ...goodFinding, severity: "P0" }], cells: [evidence("source:correctness")] }
        : { findings: [], cells: [evidence("source:correctness")] })
    },
    verifier: null,
    currentDiffHash: "h",
  })
  assert.equal(run.terminal, TERMINAL.ESCALATE)
  assert.match(run.escalations.join(" "), /never resolved by verification/)
})

test("partial adjudication still escalates", async () => {
  let n = 0
  const run = await runLoop({
    ctx: ctxFor(),
    runner: async () => {
      n++
      return okPass(n === 1
        ? { findings: [
            { ...goodFinding, severity: "P0", title: "First", line: "1" },
            { ...goodFinding, severity: "P0", title: "Second", line: "2" },
          ], cells: [evidence("source:correctness")] }
        : { findings: [], cells: [evidence("source:correctness")] })
    },
    verifier: async ({ findings, cells }) => ({
      // Only ever adjudicates "First"; "Second" is left hanging on every pass.
      verdicts: findings.filter((f) => f.title === "First").map((f) => ({ id: f.id, verdict: "confirmed", evidence: `traced a concrete path in ${f.file}` })),
      cell_verdicts: cells.map((c) => ({ id: c.id, verified: true, reason: `checked ${c.evidence?.anchors?.[0]} against the diff` })),
    }),
    currentDiffHash: "h",
  })
  assert.equal(run.terminal, TERMINAL.ESCALATE)
  assert.match(run.escalations.join(" "), /never resolved by verification/)
})

// ---- regression guards for the five reproduced false-CLEAN routes ---------------------

test("a refutation without evidence does not remove a finding", () => {
  const run = mkRun()
  applyPass(run, { index: 1 }, { findings: [goodFinding], cells: [] })
  applyVerdicts(run, [{ id: run.findings[0].fingerprint, verdict: "refuted" }])
  assert.equal(run.findings[0].verdict, null, "a bare refutation adjudicates nothing")
  assert.deepEqual(run.refuted, [])
})

test("a confirmation without evidence does not promote a finding", () => {
  const run = mkRun()
  applyPass(run, { index: 1 }, { findings: [goodFinding], cells: [] })
  applyVerdicts(run, [{ id: run.findings[0].fingerprint, verdict: "confirmed", evidence: "yes" }])
  assert.equal(run.findings[0].verdict, null)
})

test("a later pass retracting coverage also retracts the verification", () => {
  const run = mkRun({ cells: mandatoryCells(), highRisk: true })
  applyPass(run, { index: 1 }, { findings: [], cells: [evidence("migration:data", "covered", "1.sql")] })
  const cell = run.cells.find((c) => c.id === "migration:data")
  cell.verifiedIndependently = true
  assert.equal(cell.covered, true)
  applyPass(run, { index: 2 }, {
    findings: [],
    cells: [{ cell: "migration:data", status: "uncovered", anchors: [], checks: [], context_complete: false }],
  })
  assert.equal(cell.covered, false, "coverage must be retractable")
  assert.equal(cell.verifiedIndependently, false, "and its verification with it")
})

test("an anchor that merely prefixes a real path is not evidence", () => {
  const run = mkRun()
  applyPass(run, { index: 1 }, {
    findings: [],
    cells: [{ cell: "source:correctness", status: "covered", anchors: ["a.js.evil:999999"], checks: ["looked"], context_used: "the diff", disposition: "none", context_complete: true }],
  })
  assert.equal(run.cells[0].covered, false)
  assert.ok(run.cells[0].evidence.rejected.some((p) => /inspectable location/.test(p)))
})

test("a cell verdict with no stated reason does not count as verification", async () => {
  const run = await runLoop({
    ctx: ctxFor({ cells: mandatoryCells(), highRisk: true }),
    runner: async () => okPass({
      findings: [],
      cells: [evidence("source:correctness"), evidence("migration:data", "covered", "1.sql")],
    }),
    verifier: async ({ cells }) => ({ verdicts: [], cell_verdicts: cells.map((c) => ({ id: c.id, verified: true })) }),
    currentDiffHash: "h",
  })
  assert.notEqual(run.terminal, TERMINAL.CLEAN)
  assert.match(run.terminalReasons.join(" ") + run.escalations.join(" "), /independent verification|ceiling/)
})

test("budgets count verification calls, not just discovery passes", async () => {
  let discovery = 0
  const run = await runLoop({
    ctx: ctxFor(),
    runner: async () => {
      discovery++
      return { ...okPass({ findings: [], cells: [evidence("source:correctness")] }), usage: { input_tokens: 100, output_tokens: 10 }, ms: 5 }
    },
    verifier: async ({ cells }) => ({
      verdicts: [], cell_verdicts: cells.map((c) => ({ id: c.id, verified: true, reason: `checked ${c.evidence?.anchors?.[0]} against the diff` })),
      usage: { input_tokens: 500, output_tokens: 20 }, ms: 7,
    }),
    currentDiffHash: "h",
    budget: { tokens: 0, calls: 0, ms: 0 },
  })
  // Discovery alone would account 2 x 110 = 220 tokens; the verifier's usage must be included too.
  assert.ok(run.spent.tokens >= discovery * 110, "discovery usage counted")
  assert.equal(run.spent.calls, discovery, "each dispatch is one call")
})

test("a token budget stops the loop mid-run and blocks CLEAN", async () => {
  const run = await runLoop({
    ctx: ctxFor(),
    runner: async () => ({ ...okPass({ findings: [], cells: [evidence("source:correctness")] }), usage: { input_tokens: 10_000, output_tokens: 0 }, ms: 1 }),
    verifier: cellsOnlyVerifier,
    currentDiffHash: "h",
    budget: { tokens: 5_000, calls: 0, ms: 0 },
  })
  assert.notEqual(run.terminal, TERMINAL.CLEAN)
  assert.ok(run.passes.length < 4)
})

// ---- round-3 bypasses ----------------------------------------------------------------

test("a real path with a fabricated line number is not evidence", () => {
  const run = mkRun({ cells: [{ ...makeCell(SURFACE.SOURCE, RISK.CORRECTNESS, ["a.js"]), maxLine: { "a.js": 40 } }] })
  applyPass(run, { index: 1 }, {
    findings: [],
    cells: [{ cell: "source:correctness", status: "covered", anchors: ["a.js:999999"], checks: ["looked"], context_used: "the diff", disposition: "none", context_complete: true }],
  })
  assert.equal(run.cells[0].covered, false)
  assert.ok(run.cells[0].evidence.rejected.some((p) => /inspectable location/.test(p)))
})

test("vague refutation evidence cannot erase a finding", () => {
  const run = mkRun()
  applyPass(run, { index: 1 }, { findings: [goodFinding], cells: [] })
  applyVerdicts(run, [{ id: run.findings[0].fingerprint, verdict: "refuted", evidence: "not a real issue" }])
  assert.equal(run.findings[0].verdict, null, "evidence must point at the finding's file")
  assert.deepEqual(run.refuted, [])
})

test("a cell verdict that cites no anchor does not verify the cell", async () => {
  const run = await runLoop({
    ctx: ctxFor({ cells: mandatoryCells(), highRisk: true }),
    runner: async () => okPass({
      findings: [],
      cells: [evidence("source:correctness"), evidence("migration:data", "covered", "1.sql")],
    }),
    verifier: async ({ cells }) => ({
      verdicts: [],
      cell_verdicts: cells.map((c) => ({ id: c.id, verified: true, reason: "looks good enough to me" })),
    }),
    currentDiffHash: "h",
  })
  assert.notEqual(run.terminal, TERMINAL.CLEAN)
})

test("a non-array cell_verdicts does not throw", async () => {
  const run = await runLoop({
    ctx: ctxFor({ cells: mandatoryCells(), highRisk: true }),
    runner: async () => okPass({
      findings: [],
      cells: [evidence("source:correctness"), evidence("migration:data", "covered", "1.sql")],
    }),
    verifier: async () => ({ verdicts: {}, cell_verdicts: { id: "migration:data", verified: true } }),
    currentDiffHash: "h",
  })
  assert.notEqual(run.terminal, TERMINAL.CLEAN)
})

test("an exhausted budget prevents verification from being dispatched at all", async () => {
  let verifierCalls = 0
  await runLoop({
    ctx: ctxFor(),
    runner: async () => ({ ...okPass({ findings: [goodFinding], cells: [evidence("source:correctness")] }), usage: { input_tokens: 99_999, output_tokens: 0 }, ms: 1 }),
    verifier: async () => { verifierCalls++; return { verdicts: [], cell_verdicts: [] } },
    currentDiffHash: "h",
    budget: { tokens: 100, calls: 0, ms: 0 },
  })
  assert.equal(verifierCalls, 0, "budget must be checked before dispatching verification")
})

// ---- round-4 defects -----------------------------------------------------------------

test("omitting an already-covered cell leaves its earlier record standing", () => {
  // Later passes are told what is already covered so they look elsewhere. Treating silence as
  // retraction would fight that design and turn terseness into a failed run. Only a rejected or
  // retracting record withdraws coverage.
  const run = mkRun()
  applyPass(run, { index: 1 }, { findings: [], cells: [evidence("source:correctness")] })
  assert.equal(run.cells[0].covered, true)
  applyPass(run, { index: 2 }, { findings: [], cells: [] })
  assert.equal(run.cells[0].covered, true)
})

test("a cell no pass ever covered still blocks CLEAN", () => {
  const run = mkRun()
  applyPass(run, { index: 1 }, { findings: [], cells: [] })
  assert.equal(run.cells[0].covered, false)
})

test("a rejected record withdraws coverage an earlier pass established", () => {
  const run = mkRun()
  applyPass(run, { index: 1 }, { findings: [], cells: [evidence("source:correctness")] })
  run.cells[0].verifiedIndependently = true
  applyPass(run, { index: 2 }, {
    findings: [],
    cells: [{ cell: "source:correctness", status: "covered", anchors: [], checks: [], context_used: "x", disposition: "none", context_complete: true }],
  })
  assert.equal(run.cells[0].covered, false)
  assert.equal(run.cells[0].verifiedIndependently, false)
})

test("replacement evidence cannot inherit the previous approval", () => {
  const run = mkRun()
  applyPass(run, { index: 1 }, { findings: [], cells: [evidence("source:correctness")] })
  run.cells[0].verifiedIndependently = true
  run.cells[0].verifiedFor = run.cells[0].evidenceVersion
  applyPass(run, { index: 2 }, { findings: [], cells: [evidence("source:correctness")] })
  assert.equal(run.cells[0].verifiedIndependently, false, "new evidence needs new verification")
})

test("a cell approval must quote the supplied anchor, not just the file", async () => {
  const run = await runLoop({
    ctx: ctxFor({ cells: mandatoryCells(), highRisk: true }),
    runner: async () => okPass({
      findings: [],
      cells: [evidence("source:correctness"), evidence("migration:data", "covered", "1.sql")],
    }),
    verifier: async ({ cells }) => ({
      verdicts: [],
      cell_verdicts: cells.map((c) => ({ id: c.id, verified: true, reason: "I looked at 1.sql and it is fine" })),
    }),
    currentDiffHash: "h",
  })
  assert.notEqual(run.terminal, TERMINAL.CLEAN)
})

test("a finding with a malformed severity still blocks CLEAN", async () => {
  const run = await runLoop({
    ctx: ctxFor(),
    runner: async () => okPass({
      findings: [{ title: "t", file: "a.js", rationale: "r", severity: "p1", failure_scenario: "x causes y" }],
      cells: [evidence("source:correctness")],
    }),
    verifier: cellsOnlyVerifier,
    currentDiffHash: "h",
  })
  assert.notEqual(run.terminal, TERMINAL.CLEAN)
})

// ---- round-5 defects -----------------------------------------------------------------

test("a record naming an unknown cell is a rejection, not silence", async () => {
  const run = await runLoop({
    ctx: ctxFor(),
    runner: async () => okPass({
      findings: [],
      // a typo'd cell id: something was asserted, and it corresponds to nothing
      cells: [evidence("source:correctness"), { ...evidence("source:correctnes") }],
    }),
    verifier: cellsOnlyVerifier,
    currentDiffHash: "h",
  })
  assert.notEqual(run.terminal, TERMINAL.CLEAN)
  assert.match(run.terminalReasons.join(" "), /unknown cell/)
})

test("a cell approval citing a look-alike path does not verify the cell", async () => {
  const run = await runLoop({
    ctx: ctxFor({ cells: mandatoryCells(), highRisk: true }),
    runner: async () => okPass({
      findings: [],
      cells: [evidence("source:correctness"), evidence("migration:data", "covered", "1.sql")],
    }),
    // anchor is "1.sql:10"; the reason cites "not-1.sql:10", which merely contains it
    verifier: async ({ cells }) => ({
      verdicts: [],
      cell_verdicts: cells.map((c) => ({ id: c.id, verified: true, reason: "checked not-1.sql:10 carefully" })),
    }),
    currentDiffHash: "h",
  })
  assert.notEqual(run.terminal, TERMINAL.CLEAN)
})

test("verdicts are matched by a short opaque id, not by echoing the fingerprint", async () => {
  let seenIds = []
  let n = 0
  const run = await runLoop({
    ctx: ctxFor(),
    runner: async () => {
      n++
      return okPass(n === 1
        ? { findings: [{ ...goodFinding, severity: "P0" }], cells: [evidence("source:correctness")] }
        : { findings: [], cells: [evidence("source:correctness")] })
    },
    verifier: async ({ findings, cells }) => {
      seenIds = findings.map((f) => f.id)
      return {
        verdicts: findings.map((f) => ({ id: f.id, verdict: "confirmed", evidence: `traced a concrete path in ${f.file}` })),
        cell_verdicts: cells.map((c) => ({ id: c.id, verified: true, reason: `checked ${c.evidence?.anchors?.[0]}` })),
      }
    },
    currentDiffHash: "h",
  })
  assert.deepEqual(seenIds, ["F1"], "the verifier should receive a short id")
  assert.equal(run.terminal, TERMINAL.FINDINGS, "and the verdict must map back to the finding")
})

// ---- round-6 defects -----------------------------------------------------------------

test("a verdict for an id the loop never issued resolves nothing", async () => {
  let n = 0
  const run = await runLoop({
    ctx: ctxFor(),
    runner: async () => {
      n++
      return okPass(n === 1
        ? { findings: [{ ...goodFinding, severity: "P0" }], cells: [evidence("source:correctness")] }
        : { findings: [], cells: [evidence("source:correctness")] })
    },
    verifier: async ({ cells }) => ({
      // a plausible-looking fingerprint that was never handed out
      verdicts: [{ id: "a.js:10:correctness:Guard removed", verdict: "refuted", evidence: "checked a.js and it is guarded" }],
      cell_verdicts: cells.map((c) => ({ id: c.id, verified: true, reason: `checked ${c.evidence?.anchors?.[0]}` })),
    }),
    currentDiffHash: "h",
  })
  assert.notEqual(run.terminal, TERMINAL.CLEAN)
  assert.deepEqual(run.refuted, [], "an unissued id must not refute anything")
})

test("a failed verification applies nothing and blocks CLEAN", async () => {
  const run = await runLoop({
    ctx: ctxFor({ cells: mandatoryCells(), highRisk: true }),
    runner: async () => okPass({
      findings: [],
      cells: [evidence("source:correctness"), evidence("migration:data", "covered", "1.sql")],
    }),
    verifier: async ({ cells }) => ({
      state: "failed",
      verdicts: [],
      cell_verdicts: cells.map((c) => ({ id: c.id, verified: true, reason: `checked ${c.evidence?.anchors?.[0]}` })),
    }),
    currentDiffHash: "h",
  })
  assert.notEqual(run.terminal, TERMINAL.CLEAN)
  assert.match(run.terminalReasons.join(" ") + run.escalations.join(" "), /returned failed|independent verification|ceiling/)
})

test("an approval may not cite an anchor that failed validation", async () => {
  const cells = [
    { ...makeCell(SURFACE.SOURCE, RISK.CORRECTNESS, ["a.js"]), maxLine: { "a.js": 10 } },
    { ...makeCell(SURFACE.MIGRATION, RISK.DATA, ["1.sql"]), maxLine: { "1.sql": 10 } },
  ]
  const run = await runLoop({
    ctx: ctxFor({ cells, highRisk: true }),
    runner: async () => okPass({
      findings: [],
      cells: [
        { ...evidence("source:correctness"), anchors: ["a.js:1"] },
        // one valid anchor and one out of bounds; the approval will cite the invalid one
        { ...evidence("migration:data", "covered", "1.sql"), anchors: ["1.sql:1", "1.sql:999"] },
      ],
    }),
    verifier: async () => ({
      verdicts: [],
      cell_verdicts: [{ id: "migration:data", verified: true, reason: "checked 1.sql:999 carefully" }],
    }),
    currentDiffHash: "h",
  })
  assert.notEqual(run.terminal, TERMINAL.CLEAN)
})

test("a rejected record does not poison the run once valid evidence arrives", () => {
  // Deliberate: a malformed first attempt corrected by a valid one is better evidence, not a
  // permanent failure. The attempt stays visible in the coverage table instead.
  const run = mkRun()
  applyPass(run, { index: 1 }, {
    findings: [],
    cells: [{ ...evidence("source:correctness"), anchors: [] }],
  })
  assert.equal(run.cells[0].covered, false)
  applyPass(run, { index: 2 }, { findings: [], cells: [evidence("source:correctness")] })
  assert.equal(run.cells[0].covered, true)
  assert.equal(run.cells[0].evidenceHistory.filter((h) => h.problems?.length).length, 1)
})

// ---- round-8 defects -----------------------------------------------------------------

test("an inconclusive disposition is not coverage", () => {
  const run = mkRun()
  applyPass(run, { index: 1 }, {
    findings: [],
    cells: [{ ...evidence("source:correctness"), disposition: "inconclusive" }],
  })
  assert.equal(run.cells[0].covered, false, "'I looked but could not tell' is not coverage")
})

test("a reported disposition only counts when the pass admitted a finding in that cell", () => {
  const withoutFinding = mkRun()
  applyPass(withoutFinding, { index: 1 }, {
    findings: [],
    cells: [{ ...evidence("source:correctness"), disposition: "reported" }],
  })
  assert.equal(withoutFinding.cells[0].covered, false, "claimed a report with nothing admitted")

  const withFinding = mkRun()
  applyPass(withFinding, { index: 1 }, {
    findings: [goodFinding], // file a.js, which is this cell's file
    cells: [{ ...evidence("source:correctness"), disposition: "reported" }],
  })
  assert.equal(withFinding.cells[0].covered, true)
})

test("a malformed verification envelope applies nothing and blocks CLEAN", async () => {
  const run = await runLoop({
    ctx: ctxFor({ cells: mandatoryCells(), highRisk: true }),
    runner: async () => okPass({
      findings: [],
      cells: [evidence("source:correctness"), evidence("migration:data", "covered", "1.sql")],
    }),
    verifier: async () => ({ verdicts: "all good", cell_verdicts: { id: "migration:data", verified: true } }),
    currentDiffHash: "h",
  })
  assert.notEqual(run.terminal, TERMINAL.CLEAN)
  assert.match(run.terminalReasons.join(" ") + run.escalations.join(" "), /malformed envelope|independent verification|ceiling/)
})

test("a diff whose sections could not be resolved never reports CLEAN", async () => {
  const run = await runLoop({
    ctx: { ...ctxFor({ cells: [], trivial: false }), unparsed: "2 diff section(s) could not be resolved to a reviewable file" },
    runner: async () => okPass({ findings: [], cells: [] }),
    verifier: async () => ({ verdicts: [], cell_verdicts: [] }),
    currentDiffHash: "h",
  })
  assert.notEqual(run.terminal, TERMINAL.CLEAN)
  assert.match(run.terminalReasons.join(" "), /could not be resolved/)
})
