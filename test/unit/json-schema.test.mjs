import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { validate, resolveRef } from "../../scripts/lib/json-schema.mjs"

const ROOT = JSON.parse(readFileSync("contracts/loop-payload.schema.json", "utf8"))

const ok = (value, entry) => assert.deepEqual(validate(ROOT, value, entry), [])
const bad = (value, entry, match) => {
  const problems = validate(ROOT, value, entry)
  assert.ok(problems.length > 0, `expected a problem for ${JSON.stringify(value)}`)
  if (match) assert.match(problems.join("\n"), match)
}

const finding = (over = {}) => ({
  title: "t", file: "f.js", line: "1", severity: "P1", category: "correctness",
  rationale: "r", failure_scenario: "s", confidence: "high", suggested_fix: null, ...over,
})

test("accepts a well-formed finding", () => ok(finding(), "#/$defs/loopFinding"))

test("rejects a missing required property", () => {
  const f = finding()
  delete f.confidence
  bad(f, "#/$defs/loopFinding", /missing required property "confidence"/)
})

test("rejects an unknown property when additionalProperties is false", () => {
  bad(finding({ dimension: "impact" }), "#/$defs/loopFinding", /unexpected property "dimension"/)
})

test("rejects a value outside an enum", () => {
  bad(finding({ severity: "P3" }), "#/$defs/loopFinding", /not one of/)
})

test("honours a union type, and rejects members outside it", () => {
  ok(finding({ line: null }), "#/$defs/loopFinding")
  ok(finding({ line: "12-18" }), "#/$defs/loopFinding")
  bad(finding({ line: 12 }), "#/$defs/loopFinding", /expected string\|null, got integer/)
})

test("a nullable enum accepts null as a member", () => {
  ok({ id: "F1", verdict: "confirmed", evidence: "e", suggested_severity: null }, "#/$defs/verdict")
  bad({ id: "F1", verdict: "confirmed", evidence: "e", suggested_severity: "P9" }, "#/$defs/verdict", /not one of/)
})

test("follows $ref through arrays", () => {
  ok({ findings: [finding()], cells: [] }, "#/$defs/discoveryPayload")
  bad({ findings: [finding({ severity: "nope" })], cells: [] }, "#/$defs/discoveryPayload", /\$\.findings\[0\]\.severity/)
})

test("reports the path of a nested problem", () => {
  const problems = validate(ROOT, { findings: [finding(), finding({ category: "x" })], cells: [] }, "#/$defs/discoveryPayload")
  assert.match(problems.join("\n"), /\$\.findings\[1\]\.category/)
})

test("an integer satisfies a number type but a float does not satisfy integer", () => {
  const schema = { $defs: { n: { type: "number" }, i: { type: "integer" } } }
  assert.deepEqual(validate(schema, 3, "#/$defs/n"), [])
  assert.deepEqual(validate(schema, 3.5, "#/$defs/n"), [])
  assert.deepEqual(validate(schema, 3, "#/$defs/i"), [])
  assert.ok(validate(schema, 3.5, "#/$defs/i").length > 0)
})

test("an array is not an object, and null is not an object", () => {
  bad([], "#/$defs/loopFinding", /expected object, got array/)
  bad(null, "#/$defs/loopFinding", /expected object, got null/)
})

// The validator must announce its own limits rather than silently passing a schema it cannot read.
// Without this, adding `minLength` to a contract would look like it was being enforced.
test("throws on a keyword it does not implement", () => {
  assert.throws(
    () => validate({ $defs: { x: { type: "string", minLength: 1 } } }, "", "#/$defs/x"),
    /unsupported schema keyword "minLength"/
  )
})

test("throws on an unresolvable or remote $ref", () => {
  assert.throws(() => validate(ROOT, {}, "#/$defs/nope"), /does not resolve/)
  assert.throws(() => validate({ $ref: "https://example.com/s.json" }, {}), /only local/)
})

test("x- extension keywords are ignored, not rejected", () => {
  assert.deepEqual(validate({ $defs: { x: { type: "string", "x-note": "hi" } } }, "s", "#/$defs/x"), [])
})

test("resolveRef unescapes ~1 and ~0 in pointer segments", () => {
  const doc = { "a/b": { "c~d": 42 } }
  assert.equal(resolveRef(doc, "#/a~1b/c~0d"), 42)
})

test("every entrypoint the generator uses resolves", () => {
  for (const entry of ["#/$defs/discoveryPayload", "#/$defs/verifierPayload", "#/$defs/loopFinding"]) {
    assert.ok(resolveRef(ROOT, entry), entry)
  }
})
