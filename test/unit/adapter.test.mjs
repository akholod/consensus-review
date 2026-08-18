import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { interpret, extractPayload, DENIED_TOOLS } from "../../src/loop-review/adapter.mjs"
import { PASS_STATE, PASS_STATE_OK } from "../../src/loop-review/schema.mjs"

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/adapter/${name}.json`, import.meta.url), "utf8"))

const invocationFor = (name) => {
  const f = fixture(name)
  if (typeof f.rc === "number" && !f.usage) return { rc: f.rc, stdout: f.stdout ?? "", timedOut: f.rc === 124 }
  return { rc: 0, stdout: JSON.stringify(f), timedOut: false }
}

// Captured from a real CLI; these pin the interpretation against the live envelope shape.
const CASES = [
  ["ok", PASS_STATE.OK],
  ["malformed", PASS_STATE.MALFORMED], // envelope itself unparseable
  ["truncated", PASS_STATE.TRUNCATED],
  ["timeout", PASS_STATE.TIMEOUT],
  ["exit-nonzero", PASS_STATE.FAILED],
  ["refusal", PASS_STATE.REFUSED],
]

for (const [name, expected] of CASES) {
  test(`fixture ${name} interprets as ${expected}`, () => {
    assert.equal(interpret(invocationFor(name)).state, expected)
  })
}

test("no failure fixture can ever yield an ok state", () => {
  for (const [name, expected] of CASES) {
    if (expected === PASS_STATE_OK) continue
    const r = interpret(invocationFor(name))
    assert.notEqual(r.state, PASS_STATE_OK, `${name} must not be ok`)
    assert.equal(r.payload?.findings, undefined, `${name} must not contribute findings`)
  }
})

test("the ok fixture carries a real findings payload and usage", () => {
  const r = interpret(invocationFor("ok"))
  assert.equal(r.state, PASS_STATE.OK)
  assert.ok(Array.isArray(r.payload.findings))
  assert.ok(r.payload.findings.length > 0)
  assert.ok(r.usage.cache_read_input_tokens > 0)
  assert.ok(r.usage.cost_usd > 0)
})

test("a refusal is exit 0 / is_error false and must still not read as success", () => {
  const raw = fixture("refusal")
  assert.equal(raw.is_error, false)
  assert.equal(raw.subtype, "success")
  assert.equal(interpret({ rc: 0, stdout: JSON.stringify(raw), timedOut: false }).state, PASS_STATE.REFUSED)
})

test("timeout leaves no envelope and is never read as zero findings", () => {
  const r = interpret({ rc: 124, stdout: "", timedOut: true })
  assert.equal(r.state, PASS_STATE.TIMEOUT)
  assert.equal(r.payload, null)
})

test("a valid envelope whose payload lacks findings is malformed, not empty", () => {
  const env = { is_error: false, stop_reason: "end_turn", result: '{"cells":[]}', usage: {} }
  assert.equal(interpret({ rc: 0, stdout: JSON.stringify(env), timedOut: false }).state, PASS_STATE.MALFORMED)
})

test("extractPayload handles fenced and bare JSON, and rejects prose", () => {
  assert.deepEqual(extractPayload('```json\n{"findings":[]}\n```'), { findings: [] })
  assert.deepEqual(extractPayload('here you go {"findings":[]} done'), { findings: [] })
  assert.equal(extractPayload("no json at all"), null)
  assert.equal(extractPayload(null), null)
})

test("the deny list covers every repository-reading tool", () => {
  for (const t of ["Read", "Grep", "Glob", "Bash", "Task", "WebFetch", "WebSearch"]) {
    assert.ok(DENIED_TOOLS.includes(t), `${t} must be denied`)
  }
})

test("the expected payload shape is a parameter, not an assumption", () => {
  // Regression guard: the verifier returns {"verdicts":[...]}, which was being classified
  // MALFORMED because the adapter hardcoded the discovery payload's `findings` key.
  const env = { is_error: false, stop_reason: "end_turn", result: '{"verdicts":[{"id":"x","verdict":"confirmed"}]}', usage: {} }
  const asDiscovery = interpret({ rc: 0, stdout: JSON.stringify(env), timedOut: false })
  assert.equal(asDiscovery.state, PASS_STATE.MALFORMED)
  const asVerification = interpret({ rc: 0, stdout: JSON.stringify(env), timedOut: false, requireKey: "verdicts" })
  assert.equal(asVerification.state, PASS_STATE.OK)
  assert.equal(asVerification.payload.verdicts.length, 1)
})

test("a findings array containing a non-object is malformed, not an empty result", () => {
  for (const payload of ['{"findings":[null]}', '{"findings":[1,2]}', '{"findings":[[]]}']) {
    const env = { is_error: false, stop_reason: "end_turn", result: payload, usage: {} }
    const r = interpret({ rc: 0, stdout: JSON.stringify(env), timedOut: false })
    assert.equal(r.state, PASS_STATE.MALFORMED, `${payload} must be malformed`)
  }
})

test("a non-array cells member is malformed", () => {
  const env = { is_error: false, stop_reason: "end_turn", result: '{"findings":[],"cells":"all good"}', usage: {} }
  assert.equal(interpret({ rc: 0, stdout: JSON.stringify(env), timedOut: false }).state, PASS_STATE.MALFORMED)
})

test("a parseable but non-object envelope is malformed, not a crash", () => {
  for (const stdout of ["null", "[]", '"a string"', "42", "true"]) {
    const r = interpret({ rc: 0, stdout, timedOut: false })
    assert.equal(r.state, PASS_STATE.MALFORMED, `${stdout} must be malformed`)
    assert.equal(r.payload, null)
  }
})

test("non-numeric usage counters are rejected rather than corrupting accounting", () => {
  const base = { is_error: false, stop_reason: "end_turn", result: '{"findings":[],"cells":[]}' }
  for (const usage of [
    { input_tokens: { n: 1 } },
    { output_tokens: "many" },
    { cache_read_input_tokens: -5 },
    { input_tokens: Number.POSITIVE_INFINITY },
  ]) {
    const r = interpret({ rc: 0, stdout: JSON.stringify({ ...base, usage }), timedOut: false })
    assert.equal(r.state, PASS_STATE.MALFORMED, `${JSON.stringify(usage)} must be malformed`)
  }
  const bad = interpret({ rc: 0, stdout: JSON.stringify({ ...base, usage: {}, total_cost_usd: "free" }), timedOut: false })
  assert.equal(bad.state, PASS_STATE.MALFORMED)
})

test("absent usage counters default to zero without being treated as malformed", () => {
  const env = { is_error: false, stop_reason: "end_turn", result: '{"findings":[],"cells":[]}' }
  const r = interpret({ rc: 0, stdout: JSON.stringify(env), timedOut: false })
  assert.equal(r.state, PASS_STATE.OK)
  assert.equal(r.usage.input_tokens, 0)
  assert.equal(r.usage.cost_usd, 0)
})
