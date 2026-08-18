// Seeded defect corpus. Each fixture pairs a real diff with a scripted transcript so the
// orchestration can be replayed deterministically, offline, with no model involved.
// Recall against a live model is measured separately — transcripts cannot establish it.

import { PASS_STATE, TERMINAL } from "../../../src/loop-review/schema.mjs"

const diff = (path, body) => `diff --git a/${path} b/${path}
index 1111111..2222222 100644
--- a/${path}
+++ b/${path}
${body}
`

const ok = (payload) => ({ state: PASS_STATE.OK, payload, usage: {}, ms: 1, detail: "" })
// Anchors must name real files in the cell, exactly as the runtime now requires.
const FILE_FOR = {
  "migration:data": "db/migrations/007_drop_orders.sql",
  "migration:correctness": "db/migrations/007_drop_orders.sql",
  "migration:error-handling": "db/migrations/007_drop_orders.sql",
  "source:security": "src/auth/guard.js",
  "source:contract": "src/api/orders.js",
  "source:correctness": "src/util.js",
  "source:error-handling": "src/util.js",
}
const cover = (cell, complete = true, file = FILE_FOR[cell]) => ({
  cell, status: "covered", anchors: [`${file}:1`],
  checks: ["inspected the change"],
  context_used: "the diff hunk for this file", disposition: "none", context_complete: complete,
})
const uncovered = (cell) => ({ cell, status: "uncovered", anchors: [], checks: [], context_complete: false })

const finding = (over) => ({
  title: "seeded defect", file: "x", line: "1", severity: "P1", category: "correctness",
  rationale: "seeded", failure_scenario: "seeded input produces the wrong result",
  confidence: "high", suggested_fix: null, ...over,
})

const MIG = (name) => {
  const f = `db/migrations/${name}.sql`
  return [cover("migration:data", true, f), cover("migration:correctness", true, f), cover("migration:error-handling", true, f)]
}
const AUTH = () => {
  const f = "src/auth/guard.js"
  return [cover("source:security", true, f), cover("source:correctness", true, f), cover("source:error-handling", true, f)]
}
const API = () => {
  const f = "src/api/orders.js"
  return [cover("source:contract", true, f), cover("source:correctness", true, f), cover("source:error-handling", true, f)]
}
const SRC = (f) => [cover("source:correctness", true, f), cover("source:error-handling", true, f)]

/** Stub verification: adjudicates the findings a fixture declares, and vouches for its cells. */
export const verifierFor = (fixture) => async ({ findings, cells }) => ({
  // Evidence must name the finding's own file, and a cell verdict must cite one of the anchors
  // that cell's evidence supplied — the same grounding bar the runtime enforces in production.
  verdicts: fixture.verdicts(findings).map((v, i) => ({
    ...v,
    evidence: `${v.evidence} — verified at ${findings[i]?.file ?? "unknown"}`,
  })),
  cell_verdicts: cells.map((c) => ({
    id: c.id,
    verified: true,
    reason: `checked ${c.evidence?.anchors?.[0] ?? c.files?.[0]} against the diff`,
  })),
  usage: {},
  ms: 1,
})

const RAW_FIXTURES = [
  {
    id: "SD-01",
    cell: "migration:data",
    description: "destructive column drop with no rollback",
    expected: TERMINAL.FINDINGS,
    expectSeverity: "P0",
    mandatory: true,
    diff: diff("db/migrations/007_drop_orders.sql", `@@ -1,2 +1,3 @@
 BEGIN;
+ALTER TABLE orders DROP COLUMN legacy_total;
 COMMIT;`),
    transcript: [
      ok({
        findings: [finding({ severity: "P0", file: "db/migrations/007_drop_orders.sql", category: "correctness", title: "Column dropped with no rollback path", failure_scenario: "a rollback after deploy cannot restore legacy_total; the data is gone" })],
        cells: MIG("007_drop_orders"),
      }),
      ok({ findings: [], cells: MIG("007_drop_orders") }),
      ok({ findings: [], cells: MIG("007_drop_orders") }),
    ],
    verdicts: (f) => f.map((x) => ({ id: x.id, verdict: "confirmed", evidence: "traced the migration rollback gap" })),
  },
  {
    id: "SD-02",
    cell: "source:security",
    description: "authorization check removed on one branch",
    expected: TERMINAL.FINDINGS,
    expectSeverity: "P0",
    mandatory: true,
    diff: diff("src/auth/guard.js", `@@ -3,4 +3,3 @@ export function assertOwner(user, order) {
-  if (user.id !== order.userId) throw new Forbidden()
   return true
 }`),
    transcript: [
      ok({
        findings: [finding({ severity: "P0", file: "src/auth/guard.js", category: "security", title: "Ownership check removed", failure_scenario: "any authenticated user can act on another user's order" })],
        cells: AUTH(),
      }),
      ok({ findings: [], cells: AUTH() }),
      ok({ findings: [], cells: AUTH() }),
    ],
    verdicts: (f) => f.map((x) => ({ id: x.id, verdict: "confirmed", evidence: "no other guard exists on this path" })),
  },
  {
    id: "SD-03",
    cell: "source:contract",
    description: "response field keeps its name but changes meaning",
    expected: TERMINAL.FINDINGS,
    expectSeverity: "P1",
    mandatory: true,
    diff: diff("src/api/orders.js", `@@ -8,3 +8,3 @@ export function serialise(order) {
-  return { status: order.paymentState }
+  return { status: order.processingStage }
 }`),
    transcript: [
      ok({
        findings: [finding({ severity: "P1", file: "src/api/orders.js", category: "correctness", title: "status changes meaning while keeping its name", failure_scenario: "clients branching on status silently misread processing stage as payment state" })],
        cells: API(),
      }),
      ok({ findings: [], cells: API() }),
    ],
    verdicts: (f) => f.map((x) => ({ id: x.id, verdict: "confirmed", evidence: "field semantics differ from the prior release" })),
  },
  {
    id: "SD-04",
    cell: "source:correctness",
    description: "off-by-one in a changed loop bound",
    expected: TERMINAL.FINDINGS,
    expectSeverity: "P1",
    diff: diff("src/batch.js", `@@ -2,3 +2,3 @@ export function take(xs, n) {
-  for (let i = 0; i < n; i++) out.push(xs[i])
+  for (let i = 0; i <= n; i++) out.push(xs[i])
   return out`),
    transcript: [
      ok({
        findings: [finding({ file: "src/batch.js", title: "Loop bound now reads one past the end", failure_scenario: "take(xs, xs.length) appends undefined to the result" })],
        cells: SRC("src/batch.js"),
      }),
      ok({ findings: [], cells: SRC("src/batch.js") }),
    ],
    verdicts: (f) => f.map((x) => ({ id: x.id, verdict: "confirmed", evidence: "off-by-one confirmed by reading the bound" })),
  },
  {
    id: "SD-05",
    cell: "source:error-handling",
    description: "swallowed exception on a new I/O path",
    expected: TERMINAL.FINDINGS,
    expectSeverity: "P2",
    diff: diff("src/io.js", `@@ -4,3 +4,5 @@ export async function load(p) {
-  return JSON.parse(await read(p))
+  try { return JSON.parse(await read(p)) }
+  catch { return {} }
 }`),
    transcript: [
      ok({
        findings: [finding({ severity: "P2", file: "src/io.js", title: "Parse failure is swallowed", failure_scenario: null, rationale: "returns {} on any failure, matching no existing pattern in this repo where load errors propagate" })],
        cells: SRC("src/io.js"),
      }),
      ok({ findings: [], cells: SRC("src/io.js") }),
    ],
    verdicts: (f) => f.map((x) => ({ id: x.id, verdict: "confirmed", evidence: "no propagation path remains after the catch" })),
  },
  {
    id: "SD-06",
    cell: null,
    description: "clean refactor, no defect",
    expected: TERMINAL.CLEAN,
    diff: diff("src/util.js", `@@ -1,3 +1,3 @@
-export const add = (a, b) => { return a + b }
+export const add = (a, b) => a + b
 export const sub = (a, b) => a - b`),
    transcript: [
      ok({ findings: [], cells: SRC("src/util.js") }),
      ok({ findings: [], cells: SRC("src/util.js") }),
    ],
    verdicts: () => [],
  },
  {
    id: "SD-07",
    cell: null,
    description: "adapter truncation mid-run",
    expected: TERMINAL.INCONCLUSIVE,
    diff: diff("src/util.js", `@@ -1,3 +1,3 @@
-export const add = (a, b) => { return a + b }
+export const add = (a, b) => a + b
 export const sub = (a, b) => a - b`),
    transcript: [
      ok({ findings: [], cells: SRC("src/util.js") }),
      { state: PASS_STATE.TRUNCATED, payload: null, usage: {}, ms: 1, detail: "hit max_tokens" },
    ],
    verdicts: () => [],
  },
  {
    id: "SD-08",
    cell: "migration:data",
    description: "high-risk cell whose context was unavailable",
    expected: TERMINAL.ESCALATE,
    mandatory: true,
    diff: diff("db/migrations/008_backfill.sql", `@@ -1,2 +1,3 @@
 BEGIN;
+UPDATE orders SET total = total * 100 WHERE currency = 'USD';
 COMMIT;`),
    transcript: [
      ok({ findings: [], cells: [cover("migration:data", false, "db/migrations/008_backfill.sql"), ...MIG("008_backfill").slice(1)] }),
      ok({ findings: [], cells: [uncovered("migration:data"), ...MIG("008_backfill").slice(1)] }),
      ok({ findings: [], cells: [uncovered("migration:data"), ...MIG("008_backfill").slice(1)] }),
    ],
    verdicts: () => [],
  },
]

// Build each fixture's transcript with its own diff in scope, so derived anchors are correct.
export const FIXTURES = RAW_FIXTURES

/** The seeded defects a CLEAN verdict must never coexist with. */
export const MANDATORY_SEEDED = ["SD-01", "SD-02", "SD-08"]
