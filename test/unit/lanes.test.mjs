import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  allExternalDown, classifyCodexResult, classifyPiResult, decideRetry, decideReview,
  decideSceptic, helperError, killGrace, laneCommand, laneStatus, parsePiOutput, parseVerdicts, selectRefuters,
  tallyVotes, validIds, validRefuterEntry, validStatus,
} from "../../scripts/lib/lanes.mjs"

// Every row of the plan's arithmetic table: elapsed is attempt 1 fully settled, incl. TERM→KILL.
const ROWS = [
  { name: "T=900 timeout, TERM honoured", T: 900, g: 5, elapsed: 900, retry: true, t2: 895 },
  { name: "T=900 ignores TERM", T: 900, g: 5, elapsed: 905, retry: true, t2: 890 },
  { name: "T=30 ignores TERM", T: 30, g: 5, elapsed: 35, retry: true, t2: 20 },
  { name: "smoke T=660, fails at 620s", T: 660, g: 5, elapsed: 620, retry: true, t2: 660 },
  { name: "test 3a T=1 g=0.25", T: 1, g: 0.25, elapsed: 1, retry: true, t2: 0.75 },
  { name: "test 3b T=2 g=0.5 ignores TERM (KILL at 2.5 + ε)", T: 2, g: 0.5, elapsed: 2.52, retry: false, t2: 0.98 },
  { name: "test 3c T=1 g=0.25 timeout, TERM honoured", T: 1, g: 0.25, elapsed: 1, retry: true, t2: 0.75 },
]

for (const row of ROWS) {
  test(`decideRetry: ${row.name}`, () => {
    const got = decideRetry({ T: row.T, g: row.g, elapsed: row.elapsed, status: "timeout" })
    assert.equal(got.retry, row.retry)
    assert.ok(Math.abs(got.t2 - row.t2) < 1e-9, `t2 ${got.t2} != ${row.t2}`)
    // even if attempt 2 ignores TERM, it ends by TERM + g, which must not pass D = start + 2T
    if (got.retry) assert.ok(row.elapsed + got.t2 + row.g <= 2 * row.T + 1e-9)
  })
}

test("decideRetry: the retry window boundary is t2 >= min(30, T/2)", () => {
  // T=900: min(30, 450) = 30 → t2 = 1800 − elapsed − 5
  assert.equal(decideRetry({ T: 900, g: 5, elapsed: 1765, status: "failed" }).retry, true) // t2 = 30
  assert.equal(decideRetry({ T: 900, g: 5, elapsed: 1765.01, status: "failed" }).retry, false)
  // T=40: min(30, 20) = 20
  assert.equal(decideRetry({ T: 40, g: 5, elapsed: 55, status: "failed" }).retry, true) // t2 = 20
  assert.equal(decideRetry({ T: 40, g: 5, elapsed: 55.5, status: "failed" }).retry, false)
})

test("decideRetry: config and ok never retry", () => {
  assert.equal(decideRetry({ T: 900, g: 5, elapsed: 1, status: "config" }).retry, false)
  assert.equal(decideRetry({ T: 900, g: 5, elapsed: 1, status: "ok" }).retry, false)
})

test("decideRetry: a retried attempt always ends by D = start + 2T (grid invariant)", () => {
  for (const T of [1, 2.5, 30, 45, 120, 660, 900, 1800]) {
    for (const override of [null, 0, 0.1, 1, 5, 1000]) {
      const g = killGrace(T, override)
      assert.ok(g <= T / 4 + 1e-12 && g >= 0)
      for (let k = 0; k <= 20; k++) {
        const elapsed = (k / 20) * (T + g) // attempt 1 ends between 0 and T + g
        const { retry, t2 } = decideRetry({ T, g, elapsed, status: "timeout" })
        if (retry) assert.ok(elapsed + t2 + g <= 2 * T + 1e-9, `T=${T} g=${g} elapsed=${elapsed}`)
        assert.ok(T + g <= 2 * T, "attempt 1 alone fits in 2T")
      }
    }
  }
})

test("killGrace: min(5, T/4), override clamped to <= T/4", () => {
  assert.equal(killGrace(900), 5)
  assert.equal(killGrace(1), 0.25)
  assert.equal(killGrace(1, 0.4), 0.25)
  assert.equal(killGrace(2, 0.4), 0.4)
})

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "lanes-"))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Literal error lines as codex 0.166 and pi print them, not the pattern list read back.
const CONFIG_LOGS = {
  "codex auth": "ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
  "codex schema (JSON event)": '{"type":"error","message":"invalid_json_schema: Invalid schema for response_format"}',
  "codex turn.failed": '{"type":"turn.failed","error":{"message":"The model `gpt-9` does not exist or you do not have access to it."}}',
  "codex unsupported flag": "error: unexpected argument '--frobnicate' found",
  "pi unknown option": "Error: Unknown option: --no-mcp",
  "pi auth (agent_end)": JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "No API key found for provider openai" }] }),
}

for (const [name, line] of Object.entries(CONFIG_LOGS)) {
  test(`classifyCodexResult: ${name} is a config error`, () => {
    const log = `user\nReview the diff.\n${line}\n`
    assert.equal(classifyCodexResult({ rc: 1, timedOut: false, log, outPath: "/nonexistent" }).status, "config", line)
  })
}

test("classifyCodexResult: config words inside the transcript are content, not the error", () => {
  const log = [
    "user", "Review the diff at /tmp/wd/diff.patch.",
    "+  if (res.status === 401) throw new Error('unauthorized')",
    '+  const body = { "message": "user does not exist" }',
    "exec cat src/auth.js", "// returns 401 when the token does not exist",
    "ERROR: stream disconnected before completion: error sending request",
  ].join("\n")
  assert.deepEqual(classifyCodexResult({ rc: 1, timedOut: false, log, outPath: "/nonexistent" }),
    { status: "failed", reason: "stream disconnected before completion: error sending request" })
  assert.equal(classifyCodexResult({ rc: 1, timedOut: false, log: CONFIG_LOGS["codex auth"], outPath: "/x" }).reason,
    "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header")
})

for (const rc of [126, 127]) {
  test(`classifyCodexResult: rc ${rc} is a config error`, () => {
    assert.equal(classifyCodexResult({ rc, timedOut: false, log: "", outPath: "/nonexistent" }).status, "config")
  })
}

test("classifyCodexResult: a transient failure is failed, reason from the log tail", () => {
  const got = classifyCodexResult({ rc: 1, timedOut: false, log: "starting\nstream disconnected\nrate limited\n", outPath: "/x" })
  assert.deepEqual(got, { status: "failed", reason: "stream disconnected rate limited" })
  assert.equal(classifyCodexResult({ rc: 2, timedOut: false, log: "", outPath: "/x" }).reason, "exit 2")
})

test("classifyCodexResult: timedOut wins over rc", () => {
  assert.equal(classifyCodexResult({ rc: 143, timedOut: true, log: "401", outPath: "/x" }).status, "timeout")
})

test("classifyCodexResult: rc 0 without a usable file is unparseable, never zero findings", () => {
  withTmp((dir) => {
    const out = join(dir, "codex.json")
    assert.equal(classifyCodexResult({ rc: 0, timedOut: false, outPath: out }).status, "unparseable")
    writeFileSync(out, "{not json")
    assert.equal(classifyCodexResult({ rc: 0, timedOut: false, outPath: out }).status, "unparseable")
    writeFileSync(out, '{"verdicts":[]}')
    assert.equal(classifyCodexResult({ rc: 0, timedOut: false, outPath: out }).status, "unparseable")
    assert.equal(classifyCodexResult({ rc: 0, timedOut: false, outPath: out, requireKey: "verdicts" }).status, "ok")
    writeFileSync(out, '{"findings":[]}')
    assert.deepEqual(classifyCodexResult({ rc: 0, timedOut: false, outPath: out }), { status: "ok", payload: { findings: [] } })
  })
})

const piEvents = (...texts) => texts.map((text, i) => JSON.stringify(i === texts.length - 1
  ? { type: "agent_end", messages: [{ role: "assistant", provider: "p", model: "m", content: [{ type: "text", text }] }] }
  : { type: "turn_end", message: { role: "assistant", content: [{ type: "text", text }] } })).join("\n")

const finding = (title) => ({
  title, file: "a.js", line: "1", severity: "P1", dimension: "impact", category: "correctness",
  rationale: "r", failure_scenario: "s", confidence: "high", suggested_fix: null, owner: null,
})
const block = (items) => `===FINDINGS_START===${JSON.stringify(items)}===FINDINGS_END===`

test("parsePiOutput: takes the last marker block of the final message", () => {
  const raw = `noise on stderr\n${piEvents(block([finding("one")]),
    `draft ${block([finding("two")])} final ${block([finding("three")])}`)}`
  assert.deepEqual(parsePiOutput(raw), { status: "ok", payload: { findings: [finding("three")] }, model: "m", provider: "p" })
})

test("parsePiOutput: a finding that breaks contracts/finding.schema.json is unparseable", () => {
  for (const items of [[1], [{ ...finding("x"), severity: "P9" }], [{ title: "x" }], [{ ...finding("x"), extra: 1 }]]) {
    const got = parsePiOutput(piEvents(block(items)))
    assert.equal(got.status, "unparseable", JSON.stringify(items))
    assert.match(got.reason, /finding\.schema\.json/)
  }
})

test("classifyCodexResult: a finding that breaks the contract is unparseable", () => {
  withTmp((dir) => {
    const out = join(dir, "codex.json")
    writeFileSync(out, JSON.stringify({ findings: [1] }))
    assert.equal(classifyCodexResult({ rc: 0, timedOut: false, outPath: out }).status, "unparseable")
    writeFileSync(out, JSON.stringify({ findings: [{ ...finding("x"), line: 3 }] }))
    assert.equal(classifyCodexResult({ rc: 0, timedOut: false, outPath: out }).status, "unparseable")
    writeFileSync(out, JSON.stringify({ findings: [finding("x")] }))
    assert.equal(classifyCodexResult({ rc: 0, timedOut: false, outPath: out }).status, "ok")
  })
})

test("parsePiOutput: falls back to the last turn_end without agent_end", () => {
  const raw = JSON.stringify({ type: "turn_end", message: { content: [{ type: "text", text: "===VERDICTS_START===[]===VERDICTS_END===" }] } })
  assert.equal(parsePiOutput(raw, "verdicts").status, "ok")
})

test("parsePiOutput: no markers, bad JSON or a non-array is unparseable", () => {
  assert.equal(parsePiOutput(piEvents("I found nothing")).status, "unparseable")
  assert.equal(parsePiOutput(piEvents("===FINDINGS_START===[oops===FINDINGS_END===")).status, "unparseable")
  assert.equal(parsePiOutput(piEvents("===FINDINGS_START==={}===FINDINGS_END===")).status, "unparseable")
  assert.equal(parsePiOutput("").status, "unparseable")
})

test("classifyPiResult: timeout, config and failed precede parsing", () => {
  assert.equal(classifyPiResult({ rc: 0, timedOut: true, out: "" }).status, "timeout")
  assert.equal(classifyPiResult({ rc: 1, timedOut: false, out: "Error: no API key found" }).status, "config")
  assert.equal(classifyPiResult({ rc: 1, timedOut: false, out: "socket hang up" }).status, "failed")
  assert.equal(classifyPiResult({ rc: 0, timedOut: false, out: piEvents("===FINDINGS_START===[]===FINDINGS_END===") }).status, "ok")
})

test("laneStatus renders every lane status", () => {
  const ok = { status: "ok" }
  const timeout = { status: "timeout", reason: "timed out" }
  const failed = { status: "failed", reason: "rate limit" }
  assert.equal(laneStatus([ok]).display, "ok")
  assert.deepEqual(laneStatus([timeout, ok]), { status: "ok", display: "ok (retried: timeout)" })
  assert.deepEqual(laneStatus([timeout, failed]), { status: "degraded", display: "degraded (timeout; failed: rate limit)" })
  assert.equal(laneStatus([timeout]).display, "degraded (timeout; no time left)")
  assert.deepEqual(laneStatus([{ status: "config", reason: "invalid_json_schema" }]),
    { status: "failed", display: "failed: invalid_json_schema" })
})

test("laneCommand keeps the read-only flags exactly", () => {
  const opts = { repo: "/r", schema: "/s.json", out: "/o.json", brief: "B" }
  assert.deepEqual(laneCommand("codex", opts).args,
    ["exec", "-s", "read-only", "-C", "/r", "--skip-git-repo-check", "--output-schema", "/s.json", "-o", "/o.json", "B"])
  const pi = laneCommand("pi", { ...opts, model: "x/y" })
  assert.equal(pi.cwd, "/r")
  assert.deepEqual(pi.args, ["-p", "--mode", "json", "--tools", "read,grep,find,ls", "--no-mcp", "--model", "x/y", "B"])
  assert.throws(() => laneCommand("bash", opts))
})

test("parseVerdicts: unknown id ignored, duplicate invalidated, partial ok, empty unparseable", () => {
  const ids = ["F1", "F2", "F3"]
  const got = parseVerdicts({ verdicts: [
    { id: "F1", verdict: "confirmed", evidence: "" },
    { id: "F9", verdict: "refuted", evidence: "" },
    { id: "F2", verdict: "refuted", evidence: "" },
    { id: "F2", verdict: "confirmed", evidence: "" },
    { id: "F3", verdict: "reduced", evidence: "" },
  ] }, ids)
  assert.deepEqual(got, { status: "ok", votes: { F1: "confirmed" }, ignored: ["F9"], duplicates: ["F2"] })
  assert.equal(parseVerdicts({ verdicts: [] }, ids).status, "unparseable")
  assert.equal(parseVerdicts(null, ids).status, "unparseable")
  assert.deepEqual(parseVerdicts([{ id: "F3", verdict: "refuted" }], ids).votes, { F3: "refuted" })
})

const lane = (status, display = status, attempts = [{}]) => ({ status, display, attempts })

test("selectRefuters: config → skip, degraded → run, unavailable → skip, no extra → no pi", () => {
  assert.deepEqual(selectRefuters({ codex: lane("failed", "failed: invalid_json_schema") }, false),
    { "codex-refuter": "skipped (codex failed: config)" })
  assert.deepEqual(selectRefuters({ codex: lane("degraded", "degraded (timeout; timeout)") }, false), { "codex-refuter": "run" })
  assert.deepEqual(selectRefuters({ codex: lane("ok", "ok (retried: failed)") }, false), { "codex-refuter": "run" })
  assert.deepEqual(selectRefuters({ codex: lane("unavailable", "unavailable", []) }, false),
    { "codex-refuter": "skipped (unavailable)" })
  assert.deepEqual(selectRefuters({ codex: helperError("codex", "no status written") }, false),
    { "codex-refuter": "skipped (codex failed: helper error)" })
  assert.deepEqual(selectRefuters({ codex: lane("ok"), pi: lane("skipped", "skipped (no extra-advisor)", []) }, true),
    { "codex-refuter": "run", "pi-refuter": "skipped (no extra-advisor)" })
  assert.deepEqual(selectRefuters({ codex: lane("ok"), pi: lane("failed", "failed: 401") }, true),
    { "codex-refuter": "run", "pi-refuter": "skipped (pi failed: config)" })
})

test("tallyVotes: verifier missing + one refuter refuted → unconfirmed", () => {
  assert.deepEqual(tallyVotes(["F1"], { verifier: {}, "codex-refuter": { F1: "refuted" } }),
    { F1: { decision: "unconfirmed", voters: "1 of 2", noVote: ["verifier"] } })
  assert.equal(tallyVotes(["F1"], { verifier: {}, codex: { F1: "refuted" }, pi: { F1: "refuted" } }).F1.decision, "unconfirmed")
})

test("tallyVotes: tie at 2 voters, 1 voter, 3 → 2, nobody", () => {
  assert.deepEqual(tallyVotes(["F1"], { verifier: { F1: "confirmed" }, codex: { F1: "refuted" } }),
    { F1: { decision: "unconfirmed", voters: "2 of 2", noVote: [] } })
  assert.deepEqual(tallyVotes(["F1"], { verifier: { F1: "refuted" }, codex: {} }),
    { F1: { decision: "refuted", voters: "1 of 2", noVote: ["codex"] } })
  assert.deepEqual(tallyVotes(["F1"], { verifier: { F1: "confirmed" }, codex: { F1: "confirmed" }, pi: {} }),
    { F1: { decision: "confirmed", voters: "2 of 3", noVote: ["pi"] } })
  assert.equal(tallyVotes(["F1"], { verifier: { F1: "confirmed" }, codex: { F1: "refuted" }, pi: { F1: "refuted" } }).F1.decision, "refuted")
  assert.equal(tallyVotes(["F1"], { verifier: { F1: "confirmed" }, codex: { F1: "refuted" }, pi: { F1: "unconfirmed" } }).F1.decision, "unconfirmed")
  assert.deepEqual(tallyVotes(["F1"], { verifier: {}, codex: {} }),
    { F1: { decision: "unconfirmed", voters: "0 of 2", noVote: ["verifier", "codex"] } })
})

test("validStatus, validRefuterEntry and validIds fail closed", () => {
  const okAttempt = { n: 1, status: "ok", reason: null, rc: 0, seconds: 0.5 }
  const okStatus = { lane: "codex", status: "ok", display: "ok", attempts: [okAttempt] }
  assert.ok(validStatus(okStatus, "codex"))
  assert.ok(validStatus({ ...okStatus, display: "ok (retried: timeout)",
    attempts: [{ ...okAttempt, status: "timeout", reason: "timed out", rc: 143 }, { ...okAttempt, n: 2 }] }, "codex"))
  assert.ok(validStatus({ lane: "codex", status: "failed", display: "failed: x", attempts: [{ ...okAttempt, status: "config", rc: null }] }, "codex"))
  assert.ok(validStatus({ lane: "codex", status: "unavailable", display: "unavailable", attempts: [] }, "codex"))
  assert.ok(!validStatus(okStatus, "pi"), "lane must be the requested one")
  for (const bad of [null, {}, { ...okStatus, attempts: undefined }, { ...okStatus, status: "great" }, { ...okStatus, lane: undefined },
    { ...okStatus, attempts: [] }, { ...okStatus, attempts: [null] }, { ...okStatus, attempts: [{ n: "1", status: "ok" }] },
    { ...okStatus, attempts: [{ n: 1 }] },
    ...[{ n: "1" }, { n: undefined }, { status: 1 }, { reason: 1 }, { reason: undefined }, { rc: "0" }, { rc: undefined },
      { seconds: "0.5" }, { seconds: null }, { seconds: Number.NaN }].map((patch) => ({ ...okStatus, attempts: [{ ...okAttempt, ...patch }] })),
    { ...okStatus, attempts: [{ ...okAttempt, status: "timeout" }] },
    { ...okStatus, attempts: [okAttempt, { ...okAttempt, n: 2, status: "failed" }] },
  ]) assert.ok(!validStatus(bad, "codex"), JSON.stringify(bad))
  assert.ok(validRefuterEntry("run") && validRefuterEntry("skipped (codex failed: config)"))
  for (const bad of ["", "go", "skipped", "skipped ()", 1, null]) assert.ok(!validRefuterEntry(bad), String(bad))
  assert.deepEqual(validIds(["F1"]), ["F1"])
  for (const bad of [[], null, {}, [1], [""], "F1"]) assert.equal(validIds(bad), null)
})

test("allExternalDown: extra both down, default degraded + skipped pi, one ok (retried)", () => {
  assert.equal(allExternalDown({ codex: lane("degraded"), pi: lane("failed") }), true)
  assert.equal(allExternalDown({ codex: lane("degraded"), pi: lane("skipped", "skipped (no extra-advisor)") }), true)
  assert.equal(allExternalDown({ codex: lane("ok", "ok (retried: timeout)"), pi: lane("degraded") }), false)
  assert.equal(decideReview({ codex: helperError("codex", "no status written") }).allExternalDown, true)
})

test("decideSceptic: failed refuters vote nothing and drop the mode to basic", () => {
  const verifier = [{ id: "F1", verdict: "confirmed" }, { id: "F2", verdict: "refuted" }]
  const lanes = { "codex-refuter": lane("degraded", "degraded (failed: x; failed: x)"), "pi-refuter": lane("skipped", "skipped (unavailable)", []) }
  const got = decideSceptic(lanes, ["F1", "F2"], verifier, { "codex-refuter": null, "pi-refuter": null })
  assert.equal(got.voteMode, "strict → basic")
  assert.equal(got.verifier, "ok")
  assert.deepEqual(got.perFinding, {
    F1: { decision: "confirmed", voters: "1 of 2", noVote: ["codex-refuter"] },
    F2: { decision: "refuted", voters: "1 of 2", noVote: ["codex-refuter"] },
  })
  const voted = decideSceptic({ "codex-refuter": lane("ok") }, ["F1"], verifier,
    { "codex-refuter": { verdicts: [{ id: "F1", verdict: "refuted", evidence: "" }] } })
  assert.equal(voted.voteMode, "strict")
  assert.deepEqual(voted.perFinding.F1, { decision: "unconfirmed", voters: "2 of 2", noVote: [] })
})

test("decideSceptic: every sent id gets a decision, whatever the verifier returned", () => {
  const lanes = { "codex-refuter": lane("ok") }
  const refuter = { "codex-refuter": { verdicts: [{ id: "F2", verdict: "refuted", evidence: "" }] } }
  const partial = decideSceptic(lanes, ["F1", "F2", "F3"], [{ id: "F1", verdict: "confirmed" }], refuter)
  assert.equal(partial.verifier, "ok")
  assert.deepEqual(Object.keys(partial.perFinding), ["F1", "F2", "F3"])
  // a lone refuter vote never decides: without the verifier the finding stays unconfirmed
  assert.deepEqual(partial.perFinding.F2, { decision: "unconfirmed", voters: "1 of 2", noVote: ["verifier"] })
  assert.deepEqual(partial.perFinding.F3, { decision: "unconfirmed", voters: "0 of 2", noVote: ["verifier", "codex-refuter"] })
  const missing = decideSceptic(lanes, ["F1"], undefined, refuter)
  assert.equal(missing.verifier, "missing")
  assert.deepEqual(missing.perFinding.F1, { decision: "unconfirmed", voters: "0 of 2", noVote: ["verifier", "codex-refuter"] })
  assert.equal(decideSceptic(lanes, ["F1"], null, refuter).verifier, "invalid")
  assert.equal(decideSceptic(lanes, ["F1"], { nope: 1 }, refuter).verifier, "invalid")
  const noIds = decideSceptic(lanes, null, [], refuter)
  assert.equal(noIds.error, "failed: helper error (no ids)")
  assert.deepEqual(noIds.perFinding, {})
})
