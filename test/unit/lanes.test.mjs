import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CLAUDE_CLI_MODEL, allExternalDown, classifyClaudeResult, classifyCodexResult, classifyPiResult, decideRetry,
  decideReview, decideSceptic, family, helperError, killGrace, laneCommand, laneStatus, parsePiModels, parsePiOutput,
  parseVotes, pickPiModel, renderSceptic, selectConsultants, selectRefuters, tallyVotes, validIds, validRefuterEntry, validStatus,
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
  // A lane that omits `lens` gets it filled with null (D7).
  assert.deepEqual(parsePiOutput(raw), { status: "ok", payload: { findings: [{ ...finding("three"), lens: null }] }, model: "m", provider: "p" })
})

test("payloadProblem: a finding without lens is valid and gets lens null (codex)", () => {
  withTmp((dir) => {
    const out = join(dir, "codex.json")
    writeFileSync(out, JSON.stringify({ findings: [finding("x")] }))
    const got = classifyCodexResult({ rc: 0, timedOut: false, outPath: out })
    assert.equal(got.status, "ok")
    assert.equal(got.payload.findings[0].lens, null)
  })
})

test("payloadProblem: a lens name is kept, a non-string lens breaks the contract", () => {
  withTmp((dir) => {
    const out = join(dir, "codex.json")
    writeFileSync(out, JSON.stringify({ findings: [{ ...finding("x"), lens: "payments" }] }))
    assert.equal(classifyCodexResult({ rc: 0, timedOut: false, outPath: out }).payload.findings[0].lens, "payments")
    writeFileSync(out, JSON.stringify({ findings: [{ ...finding("x"), lens: 42 }] }))
    const got = classifyCodexResult({ rc: 0, timedOut: false, outPath: out })
    assert.equal(got.status, "unparseable")
    assert.match(got.reason, /^output does not match contracts\/finding\.schema\.json/)
  })
})

test("parsePiOutput: a pi block without lens is ok", () => {
  assert.equal(parsePiOutput(piEvents(block([finding("x")]))).status, "ok")
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
  assert.deepEqual(pi.args, ["-p", "--mode", "json", "--tools", "read,grep,find,ls", "--no-mcp", "--no-extensions", "--no-session",
    "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve", "--model", "x/y", "B"])
  assert.throws(() => laneCommand("bash", opts))
})

const CITE = { file: "a.js", line: "12", quote: "if (GUARD) return" }
const vote = (verdict, extra = {}) => ({ verdict, evidence: "", citation: null, reason: null, ...extra })

test("parseVotes: unknown id ignored, duplicate invalidated, partial ok, empty unparseable", () => {
  const ids = ["F1", "F2", "F3"]
  const got = parseVotes({ verdicts: [
    { id: "F1", verdict: "AGREE", evidence: "a.js:3" },
    { id: "F9", verdict: "DISAGREE_CONCERN", evidence: "" },
    { id: "F2", verdict: "DISAGREE_CONCERN", evidence: "" },
    { id: "F2", verdict: "AGREE", evidence: "" },
    { id: "F3", verdict: "reduced", evidence: "" },
  ] }, ids)
  assert.deepEqual(got, { status: "ok", votes: { F1: vote("AGREE", { evidence: "a.js:3" }) }, ignored: ["F9"], duplicates: ["F2"] })
  assert.equal(parseVotes({ verdicts: [] }, ids).status, "unparseable")
  assert.equal(parseVotes(null, ids).status, "unparseable")
  assert.deepEqual(parseVotes([{ id: "F3", verdict: "toString" }, { id: "F1", verdict: "hasOwnProperty" }], ids).votes, {})
})

test("parseVotes: the schema's kinds and the legacy words, refuted kept as evidence only with a citation", () => {
  const ids = ["F1", "F2", "F3", "F4", "F5", "F6"]
  const got = parseVotes([
    { id: "F1", verdict: "AGREE", evidence: "harm at a.js:1", citation: CITE },
    { id: "F2", verdict: "DISAGREE_EVIDENCE", evidence: "guarded", citation: CITE },
    { id: "F3", verdict: "DISAGREE_CONCERN", evidence: { why: 1 } },
    { id: "F4", verdict: "confirmed" },
    { id: "F5", verdict: "unconfirmed", evidence: "unsure" },
    { id: "F6", verdict: "refuted", evidence: "x", citation: { ...CITE, line: 12 } },
  ], ids).votes
  assert.deepEqual(got, {
    F1: vote("AGREE", { evidence: "harm at a.js:1" }),
    F2: vote("DISAGREE_EVIDENCE", { evidence: "guarded", citation: CITE }),
    F3: vote("DISAGREE_CONCERN", { evidence: '{"why":1}' }),
    F4: vote("AGREE"),
    F5: vote("DISAGREE_CONCERN", { evidence: "unsure" }),
    F6: vote("DISAGREE_EVIDENCE", { evidence: "x", citation: CITE }),
  })
  assert.deepEqual(parseVotes([{ id: "F1", verdict: "refuted", evidence: "no" }], ids).votes.F1,
    vote("DISAGREE_CONCERN", { evidence: "no", reason: "legacy refuted without citation" }))
})

test("parseVotes: a malformed citation turns evidence into a concern; a numeric line is accepted", () => {
  for (const citation of [{ ...CITE, line: { n: 1 } }, { line: "1", quote: "x" }, { ...CITE, file: "" }, "a.js:1",
    { ...CITE, quote: 7 }, { ...CITE, line: Number.NaN }, [CITE], null, undefined]) {
    const got = parseVotes([{ id: "F1", verdict: "DISAGREE_EVIDENCE", evidence: "e", citation }], ["F1"]).votes.F1
    assert.deepEqual(got, vote("DISAGREE_CONCERN", { evidence: "e", reason: "malformed citation" }), JSON.stringify(citation))
  }
  const numeric = parseVotes([{ id: "F1", verdict: "DISAGREE_EVIDENCE", citation: { ...CITE, line: 12, extra: true } }], ["F1"])
  assert.deepEqual(numeric.votes.F1.citation, CITE)
})

const lane = (status, display = status, attempts = [{}]) => ({ status, display, attempts })

/** Test quote check: a quote verifies iff it contains GUARD. */
const GUARDED = { verifyCitation: (c) => (c.quote.includes("GUARD") ? { verified: true, reason: null, source: "diff" }
  : { verified: false, reason: "quote not found", source: null }) }
const ballot = (id, verdict, extra = {}) =>
  ({ id, verdict, evidence: "", citation: verdict === "DISAGREE_EVIDENCE" ? CITE : null, suggested_severity: null, ...extra })
const core = ({ decision, voters, noVote }) => ({ decision, voters, noVote })
const coreOf = (perFinding) => Object.fromEntries(Object.entries(perFinding).map(([id, e]) => [id, core(e)]))

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

test("tallyVotes: verifier missing + one refuter evidence → unconfirmed", () => {
  assert.deepEqual(tallyVotes(["F1"], { verifier: {}, "codex-refuter": { F1: "DISAGREE_EVIDENCE" } }),
    { F1: { decision: "unconfirmed", voters: "1 of 2", noVote: ["verifier"], votes: { "codex-refuter": "DISAGREE_EVIDENCE" } } })
  assert.equal(tallyVotes(["F1"], { verifier: {}, codex: { F1: "DISAGREE_EVIDENCE" }, pi: { F1: "DISAGREE_EVIDENCE" } }).F1.decision, "unconfirmed")
})

test("tallyVotes: tie at 2 voters, 1 voter, 3 → 2, nobody", () => {
  assert.deepEqual(tallyVotes(["F1"], { verifier: { F1: "AGREE" }, codex: { F1: "DISAGREE_EVIDENCE" } }),
    { F1: { decision: "unconfirmed", voters: "2 of 2", noVote: [], votes: { verifier: "AGREE", codex: "DISAGREE_EVIDENCE" } } })
  assert.deepEqual(tallyVotes(["F1"], { verifier: { F1: "DISAGREE_EVIDENCE" }, codex: {} }),
    { F1: { decision: "refuted", voters: "1 of 2", noVote: ["codex"], votes: { verifier: "DISAGREE_EVIDENCE" } } })
  assert.deepEqual(tallyVotes(["F1"], { verifier: { F1: "AGREE" }, codex: { F1: "AGREE" }, pi: {} }),
    { F1: { decision: "confirmed", voters: "2 of 3", noVote: ["pi"], votes: { verifier: "AGREE", codex: "AGREE" } } })
  assert.equal(tallyVotes(["F1"], { verifier: { F1: "AGREE" }, codex: { F1: "DISAGREE_EVIDENCE" }, pi: { F1: "DISAGREE_EVIDENCE" } }).F1.decision, "refuted")
  assert.equal(tallyVotes(["F1"], { verifier: { F1: "AGREE" }, codex: { F1: "DISAGREE_EVIDENCE" }, pi: { F1: "DISAGREE_CONCERN" } }).F1.decision, "unconfirmed")
  assert.deepEqual(tallyVotes(["F1"], { verifier: {}, codex: {} }),
    { F1: { decision: "unconfirmed", voters: "0 of 2", noVote: ["verifier", "codex"], votes: {} } })
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
  const verifier = [ballot("F1", "AGREE"), ballot("F2", "DISAGREE_EVIDENCE")]
  const lanes = { "codex-refuter": lane("degraded", "degraded (failed: x; failed: x)"), "pi-refuter": lane("skipped", "skipped (unavailable)", []) }
  const got = decideSceptic(lanes, ["F1", "F2"], verifier, { "codex-refuter": null, "pi-refuter": null }, GUARDED)
  assert.equal(got.voteMode, "strict → basic")
  assert.equal(got.verifier, "ok")
  assert.deepEqual(coreOf(got.perFinding), {
    F1: { decision: "confirmed", voters: "1 of 2", noVote: ["codex-refuter"] },
    F2: { decision: "refuted", voters: "1 of 2", noVote: ["codex-refuter"] },
  })
  const voted = decideSceptic({ "codex-refuter": lane("ok") }, ["F1"], verifier,
    { "codex-refuter": { verdicts: [ballot("F1", "DISAGREE_EVIDENCE")] } }, GUARDED)
  assert.equal(voted.voteMode, "strict")
  assert.deepEqual(core(voted.perFinding.F1), { decision: "unconfirmed", voters: "2 of 2", noVote: [] })
})

test("decideSceptic: every sent id gets a decision, whatever the verifier returned", () => {
  const lanes = { "codex-refuter": lane("ok") }
  const refuter = { "codex-refuter": { verdicts: [ballot("F2", "DISAGREE_EVIDENCE")] } }
  const partial = decideSceptic(lanes, ["F1", "F2", "F3"], [ballot("F1", "AGREE")], refuter, GUARDED)
  assert.equal(partial.verifier, "ok")
  assert.deepEqual(Object.keys(partial.perFinding), ["F1", "F2", "F3"])
  // a lone refuter vote never decides: without the verifier the finding stays unconfirmed
  assert.deepEqual(core(partial.perFinding.F2), { decision: "unconfirmed", voters: "1 of 2", noVote: ["verifier"] })
  assert.deepEqual(core(partial.perFinding.F3), { decision: "unconfirmed", voters: "0 of 2", noVote: ["verifier", "codex-refuter"] })
  const missing = decideSceptic(lanes, ["F1"], undefined, refuter, GUARDED)
  assert.equal(missing.verifier, "missing")
  assert.deepEqual(core(missing.perFinding.F1), { decision: "unconfirmed", voters: "0 of 2", noVote: ["verifier", "codex-refuter"] })
  assert.equal(decideSceptic(lanes, ["F1"], null, refuter).verifier, "invalid")
  assert.equal(decideSceptic(lanes, ["F1"], { nope: 1 }, refuter).verifier, "invalid")
  const noIds = decideSceptic(lanes, null, [], refuter)
  assert.equal(noIds.error, "failed: helper error (no ids)")
  assert.deepEqual(noIds.perFinding, {})
})

const FIXTURES = new URL("../fixtures/", import.meta.url).pathname
const fixture = (name) => readFileSync(join(FIXTURES, name), "utf8")

test("family: positive match, first wins (anthropic first), anything else unknown", () => {
  assert.equal(family("codex"), "openai")
  assert.equal(family("claude-cli"), "anthropic")
  const pi = (provider, model) => family("pi", { provider, model })
  const cases = [
    ["claude-bridge", "claude-sonnet-5-5", "anthropic"], ["anthropic", "x", "anthropic"],
    ["google-vertex", "claude-opus-5", "anthropic"], ["amazon-bedrock", "claude-haiku-5-5", "anthropic"],
    ["openai-codex", "gpt-6.1-terra", "openai"], ["opencode-go", "gpt-6-luna", "openai"],
    ["openrouter", "google/gemini-3-pro", "google"], ["openrouter", "o3-mini", "openai"],
    ["opencode-go", "glm-5.3", "zhipu"], ["opencode-go", "kimi-k3.1-pro", "moonshot"],
    ["opencode-go", "qwen3.8-max", "qwen"], ["opencode-go", "grok-4.7", "xai"],
    ["opencode-go", "deepseek-v4-pro", "deepseek"], ["acme", "x1", "unknown"], ["opencode-go", "hy3", "unknown"],
    ["google", "gemini-test", "google"],
  ]
  for (const [provider, model, want] of cases) assert.equal(pi(provider, model), want, `${provider} ${model}`)
  assert.equal(family("pi", { provider: null, model: null }), "unknown")
  assert.equal(family("pi", undefined), "unknown")
  assert.equal(family("pi", { provider: "opencode-go", model: null }), "unknown", "opencode-go must not match /codex/")
  assert.equal(family("opencode"), "unknown")
})

const CATALOG = parsePiModels(fixture("pi-list-models.txt"))

test("parsePiModels: the captured table, header dropped", () => {
  assert.equal(CATALOG.length, 52)
  assert.deepEqual(CATALOG[0], { provider: "claude-bridge", model: "claude-fable-5" })
  assert.deepEqual(CATALOG.at(-1), { provider: "opencode-go", model: "step-5-preview" })
  assert.deepEqual(parsePiModels(""), [])
  assert.deepEqual(parsePiModels("provider  model  context\n"), [])
})

test("pickPiModel on the captured catalog", () => {
  const without = (re) => CATALOG.filter((r) => !re.test(r.model))
  assert.equal(pickPiModel("primary", CATALOG).model, "openai-codex/gpt-6.1-terra")
  assert.equal(pickPiModel("primary", CATALOG.filter((r) => r.provider !== "openai-codex")).model, "opencode-go/gpt-6-luna")
  assert.equal(pickPiModel("primary", without(/^gpt/)).model, "opencode-go/glm-5.3")
  assert.equal(pickPiModel("extra", CATALOG).model, "opencode-go/glm-5.3")
  assert.equal(pickPiModel("extra", without(/^glm/)).model, "opencode-go/qwen3.8-max")
  assert.equal(pickPiModel("extra", without(/^(glm|qwen)/)).model, "opencode-go/kimi-k3.1-pro")
  // never a Claude model, even when it is the only row
  const claudeOnly = CATALOG.filter((r) => family("pi", r) === "anthropic")
  assert.deepEqual(pickPiModel("primary", claudeOnly), { none: "no non-Claude pi model" })
  assert.deepEqual(pickPiModel("extra", claudeOnly), { none: "no independent pi model" })
  assert.deepEqual(pickPiModel("primary", []), { none: "no non-Claude pi model" })
  assert.deepEqual(pickPiModel("extra", []), { none: "no independent pi model" })
  for (const role of ["primary", "extra"]) {
    for (const rows of [CATALOG, without(/^gpt/), without(/^(gpt|glm)/), without(/^(gpt|glm|qwen)/)]) {
      const got = pickPiModel(role, rows)
      if (got.model) assert.doesNotMatch(got.model, /claude/)
    }
  }
})

test("pickPiModel: deterministic newest — numeric order, flash/free/mini dropped, ties by catalog order", () => {
  const rows = (...pairs) => pairs.map(([provider, model]) => ({ provider, model }))
  assert.equal(pickPiModel("primary", rows(["openai-codex", "gpt-6.1-sol"], ["openai-codex", "gpt-6.1-terra"])).model, "openai-codex/gpt-6.1-terra")
  assert.equal(pickPiModel("primary", rows(["openai-codex", "gpt-6.1-terra"], ["openai-codex", "gpt-6.1-sol"])).model, "openai-codex/gpt-6.1-terra")
  assert.equal(pickPiModel("extra", rows(["opencode-go", "kimi-k3.1-pro"], ["opencode-go", "kimi-k3"])).model, "opencode-go/kimi-k3.1-pro")
  assert.equal(pickPiModel("extra", rows(["opencode-go", "glm-5.10"], ["opencode-go", "glm-5.9"])).model, "opencode-go/glm-5.10")
  assert.equal(pickPiModel("extra", rows(["opencode-go", "glm-6-flash"], ["opencode-go", "glm-6-free"], ["x", "glm-5"])).model, "x/glm-5")
  assert.equal(pickPiModel("primary", rows(["a", "gpt-7-mini"], ["b", "gpt-6"])).model, "b/gpt-6")
  assert.equal(pickPiModel("primary", rows(["first", "gpt-6-luna"], ["second", "gpt-6-luna"])).model, "first/gpt-6-luna")
})

const ALL = { codex: true, pi: true, claude: true }
const names = (sel) => sel.lanes.map((l) => l.name)

test("selectConsultants: the cascade over all 8 installed subsets, no flags", () => {
  for (let mask = 0; mask < 8; mask++) {
    const installed = { codex: Boolean(mask & 1), pi: Boolean(mask & 2), claude: Boolean(mask & 4) }
    const sel = selectConsultants({ installed, piModels: CATALOG })
    const want = installed.codex ? "codex" : installed.pi ? "pi" : installed.claude ? "claude-cli" : "codex"
    assert.deepEqual(names(sel), [want], JSON.stringify(installed))
    assert.equal(sel.lanes[0].skip, mask === 0 ? "unavailable" : null, JSON.stringify(installed))
    assert.equal(sel.extraNote, null)
    assert.equal(typeof sel.reason, "string")
  }
  const pi = selectConsultants({ installed: { pi: true, claude: true }, piModels: CATALOG }).lanes[0]
  assert.deepEqual(pi, { name: "pi", brief: "brief-pi.md", refuterBrief: "refuter-brief-pi.md",
    model: "openai-codex/gpt-6.1-terra", skip: null, skipReason: null })
  const cli = selectConsultants({ installed: { claude: true } })
  assert.deepEqual(cli.lanes, [{ name: "claude-cli", brief: "brief.md", refuterBrief: "refuter-brief.md",
    model: CLAUDE_CLI_MODEL, skip: null, skipReason: null }])
  assert.equal(CLAUDE_CLI_MODEL, "sonnet")
  assert.deepEqual(selectConsultants({ installed: {} }).lanes[0],
    { name: "codex", brief: "brief.md", refuterBrief: "refuter-brief.md", model: null, skip: "unavailable", skipReason: null })
})

test("selectConsultants: an automatic pi without a usable model gives way to claude-cli", () => {
  for (const piModels of [null, [], CATALOG.filter((r) => family("pi", r) === "anthropic")]) {
    const sel = selectConsultants({ installed: { pi: true, claude: true }, piModels })
    assert.deepEqual(names(sel), ["claude-cli"], JSON.stringify(piModels))
    assert.match(sel.reason, /pi not usable/)
  }
  // nothing to give way to: codex unavailable, as today
  assert.deepEqual(names(selectConsultants({ installed: { pi: true }, piModels: [] })), ["codex"])
  // an explicit model pins the automatic pi without the catalog
  assert.equal(selectConsultants({ installed: { pi: true, claude: true }, piModels: null, extraModel: "x/y" }).lanes[0].model, "x/y")
})

test("selectConsultants: a forced consultant is never substituted", () => {
  for (const consultant of ["codex", "pi", "claude-cli", "claude"]) {
    const want = consultant === "claude" ? "claude-cli" : consultant
    const here = selectConsultants({ installed: ALL, consultant, piModels: CATALOG }).lanes
    assert.deepEqual(here.map((l) => [l.name, l.skip]), [[want, null]], consultant)
    const key = want === "claude-cli" ? "claude" : want
    const missing = selectConsultants({ installed: { ...ALL, [key]: false }, consultant, piModels: CATALOG })
    assert.deepEqual(missing.lanes.map((l) => [l.name, l.skip, l.skipReason]), [[want, "unavailable", "forced, not installed"]], consultant)
  }
  for (const [piModels, skipReason] of [[null, "pi --list-models failed"], [[], "no non-Claude pi model"],
    [CATALOG.filter((r) => family("pi", r) === "anthropic"), "no non-Claude pi model"]]) {
    const sel = selectConsultants({ installed: ALL, consultant: "pi", piModels })
    assert.deepEqual(sel.lanes.map((l) => [l.name, l.skip, l.skipReason]), [["pi", "unavailable", skipReason]])
    // with an explicit model the forced pi runs on it, catalog or not
    assert.deepEqual(selectConsultants({ installed: ALL, consultant: "pi", piModels, extraModel: "m/x" }).lanes
      .map((l) => [l.name, l.model, l.skip]), [["pi", "m/x", null]])
  }
  assert.throws(() => selectConsultants({ installed: ALL, consultant: "opencode" }), /unknown consultant/)
})

test("selectConsultants: extra", () => {
  const sel = selectConsultants({ installed: ALL, extra: true, piModels: CATALOG })
  assert.deepEqual(sel.lanes.map((l) => [l.name, l.model, l.skip]), [["codex", null, null], ["pi", "opencode-go/glm-5.3", null]])
  assert.match(sel.reason, /pi as extra: opencode-go\/glm-5\.3 \(glm preferred for independence\)/)
  assert.equal(selectConsultants({ installed: ALL, extra: true, extraModel: "openai/gpt-x", piModels: null }).lanes[1].model, "openai/gpt-x")
  for (const piModels of [null, [], CATALOG.filter((r) => !/^(glm|qwen|kimi)/.test(r.model))]) {
    assert.deepEqual(selectConsultants({ installed: ALL, extra: true, piModels }).lanes[1],
      { name: "pi", brief: "brief-pi.md", refuterBrief: "refuter-brief-pi.md", model: null, skip: "unavailable", skipReason: "no independent pi model" })
  }
  assert.deepEqual(selectConsultants({ installed: { codex: true }, extra: true }).lanes.map((l) => [l.name, l.skip]),
    [["codex", null], ["pi", "unavailable"]])
  const cli = selectConsultants({ installed: ALL, consultant: "claude", extra: true, piModels: CATALOG })
  assert.deepEqual(names(cli), ["claude-cli", "pi"])
  // primary pi + extra: exactly one pi lane, and the extra model still pins it
  for (const installed of [{ pi: true, claude: true }, ALL]) {
    const one = selectConsultants({ installed, consultant: installed.codex ? "pi" : undefined, extra: true, extraModel: "m/x", piModels: CATALOG })
    assert.deepEqual(one.lanes.map((l) => [l.name, l.model]), [["pi", "m/x"]])
    assert.equal(one.extraNote, "skipped (pi is the consultant)")
  }
})

test("laneCommand claude-cli: the spike's read-only argv, schema inline, model default in one place", () => {
  const schema = join(new URL("../../contracts/", import.meta.url).pathname, "finding.schema.json")
  process.env.CLAUDE_CODE_SESSION_ID = "s"
  process.env.CLAUDECODE = "1"
  process.env.CLAUDE_CODE_USE_BEDROCK = "1"
  try {
    const cmd = laneCommand("claude-cli", { repo: "/r", wd: "/w", schema, brief: "B" })
    assert.equal(cmd.bin, "claude")
    assert.equal(cmd.cwd, "/r")
    assert.deepEqual(cmd.args, ["--safe-mode", "--restricted", "--tools", "Read,Grep,Glob", "--add-dir", "/w",
      "--no-session-persistence", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--permission-mode", "dontAsk",
      "--json-schema", JSON.stringify(JSON.parse(readFileSync(schema, "utf8"))), "--output-format", "stream-json", "--verbose",
      "--model", "sonnet", "-p", "B"])
    for (const banned of ["Bash", "Edit", "Write"]) assert.ok(!cmd.args.join(" ").includes(banned))
    assert.equal(cmd.env.CLAUDECODE, undefined)
    assert.equal(cmd.env.CLAUDE_CODE_SESSION_ID, undefined)
    assert.equal(cmd.env.PATH, process.env.PATH)
    assert.equal(cmd.env.CLAUDE_CODE_USE_BEDROCK, "1", "auth/provider variables are kept")
    const pinned = laneCommand("claude-cli", { repo: "/r", wd: "/w", schema, brief: "B", model: "opus" }).args
    assert.equal(pinned[pinned.indexOf("--model") + 1], "opus")
  } finally {
    delete process.env.CLAUDE_CODE_SESSION_ID
    delete process.env.CLAUDECODE
    delete process.env.CLAUDE_CODE_USE_BEDROCK
  }
})

test("classifyClaudeResult on the captured envelopes", () => {
  const ok = classifyClaudeResult({ rc: 0, timedOut: false, out: fixture("claude-cli/ok.json") })
  assert.equal(ok.status, "ok")
  assert.equal(ok.payload.findings.length, 1)
  assert.equal(ok.model, "claude-sonnet-5-5")
  const stream = classifyClaudeResult({ rc: 0, timedOut: false, out: fixture("claude-cli/ok-stream.jsonl") })
  assert.equal(stream.status, "ok")
  assert.equal(stream.model, "claude-sonnet-5-5")
  // with --json-schema a refusal is a valid empty payload: indistinguishable from a clean review
  assert.deepEqual(classifyClaudeResult({ rc: 0, timedOut: false, out: fixture("claude-cli/refusal-empty-findings.json") }).payload, { findings: [] })
  const prose = classifyClaudeResult({ rc: 0, timedOut: false, out: fixture("claude-cli/prose-synth.json") })
  assert.equal(prose.status, "unparseable")
  const model = classifyClaudeResult({ rc: 1, timedOut: false, out: fixture("claude-cli/error-model.json") })
  assert.equal(model.status, "config")
  assert.match(model.reason, /issue with the selected model/)
})

const envelope = (patch) => JSON.stringify({ type: "result", subtype: "success", is_error: false, stop_reason: "tool_use",
  result: "", structured_output: { findings: [] }, ...patch })

test("classifyClaudeResult: the last result line of a mixed log decides", () => {
  const stderr = "Warning: no stdin data received in 3s, proceeding without it..."
  const first = envelope({ structured_output: { findings: [1] } })
  const out = [stderr, JSON.stringify({ type: "system", subtype: "init", model: "m" }), first, "not json", envelope({}), stderr].join("\n")
  assert.deepEqual(classifyClaudeResult({ rc: 0, timedOut: false, out }), { status: "ok", payload: { findings: [] }, model: "m" })
  assert.equal(classifyClaudeResult({ rc: 0, timedOut: false, out: `${envelope({})}\n${first}` }).status, "unparseable")
})

test("classifyClaudeResult: config only on the error text, is_error over subtype, max_tokens, no envelope", () => {
  const run = (out, rc = 0, timedOut = false) => classifyClaudeResult({ rc, timedOut, out })
  for (const text of ["Invalid API key · Please run /login", "Please run /login", "Credit balance is too low",
    "model X may not exist or you may not have access to it"]) {
    assert.equal(run(envelope({ is_error: true, result: text }), 1).status, "config", text)
  }
  // a config word in the transcript is content; the envelope's own error is transient
  const log = ["+ throw new Error('Invalid API key')", envelope({ is_error: true, result: "Overloaded" })].join("\n")
  assert.deepEqual(run(log, 1), { status: "failed", reason: "Overloaded", model: null })
  assert.equal(run(envelope({ is_error: true, subtype: "success", result: "API Error: 500" })).status, "failed")
  assert.equal(run(envelope({ stop_reason: "max_tokens" })).status, "unparseable")
  assert.equal(run(envelope({ structured_output: undefined })).status, "unparseable")
  assert.equal(run(envelope({ structured_output: { findings: [{ title: "x" }] } })).status, "unparseable")
  assert.equal(run(envelope({ structured_output: { verdicts: [] } })).status, "unparseable")
  assert.equal(classifyClaudeResult({ rc: 0, timedOut: false, out: envelope({ structured_output: { verdicts: [] } }), requireKey: "verdicts" }).status, "ok")
  assert.equal(run("", 0, true).status, "timeout")
  assert.equal(run("partial", 143, true).status, "timeout")
  assert.equal(run("socket hang up", 1).status, "failed")
  assert.equal(run("").status, "failed")
  assert.equal(run("", 127).status, "config")
})

const piLane = (provider, model, status = "ok") => ({ ...lane(status), provider, model })

test("selectRefuters: one per lane present, one per family, none from the panel or unknown", () => {
  assert.deepEqual(selectRefuters({ pi: piLane("openai-codex", "gpt-6.1-terra") }), { "pi-refuter": "run" })
  assert.deepEqual(selectRefuters({ "claude-cli": lane("ok") }), { "claude-cli-refuter": "skipped (same-family)" })
  assert.deepEqual(selectRefuters({ codex: lane("ok"), pi: piLane("openai-codex", "gpt-6.1-terra") }),
    { "codex-refuter": "run", "pi-refuter": "skipped (same-family as codex)" })
  assert.deepEqual(selectRefuters({ codex: lane("ok"), pi: piLane(null, null) }),
    { "codex-refuter": "run", "pi-refuter": "skipped (independence unknown)" })
  assert.deepEqual(selectRefuters({ codex: lane("ok"), pi: piLane("opencode-go", "glm-5.3", "degraded") }),
    { "codex-refuter": "run", "pi-refuter": "run" })
  assert.deepEqual(selectRefuters({ "claude-cli": lane("ok"), pi: piLane("claude-bridge", "claude-opus-5") }),
    { "claude-cli-refuter": "skipped (same-family)", "pi-refuter": "skipped (same-family)" })
  assert.deepEqual(selectRefuters({}), {})
})

test("helperError: a synthetic status carries kind (from the name), brief and requestedModel", () => {
  assert.deepEqual(helperError("pi-refuter", "no ids"), {
    lane: "pi-refuter", kind: "pi", brief: null, requestedModel: null, status: "failed", display: "failed: helper error (no ids)", attempts: [],
  })
  assert.ok(validStatus(helperError("codex", "x"), "codex"))
})

test("decideReview: extraSameEngine ignores a primary that never ran", () => {
  const d = decideReview({
    codex: { lane: "codex", kind: "codex", status: "unavailable", display: "unavailable", attempts: [] },
    pi: { lane: "pi", kind: "pi", status: "ok", display: "ok", attempts: [], provider: "openai-codex", model: "gpt-6.1-terra" },
  })
  assert.equal(d.extraSameEngine, false)
})

test("decideReview: family per lane — codex plus pi on OpenAI is one family, not two", () => {
  const same = decideReview({ codex: lane("ok"), pi: piLane("openai-codex", "gpt-6.1-terra") })
  assert.deepEqual(same.family, { codex: "openai", pi: "openai" })
  assert.equal(new Set(Object.values(same.family).filter((fam) => fam !== "unknown")).size, 1)
  assert.deepEqual(decideReview({ "claude-cli": lane("ok"), pi: piLane(null, null, "failed") }).family,
    { "claude-cli": "anthropic", pi: "unknown" })
  assert.deepEqual(decideReview({ codex: lane("ok"), pi: piLane("opencode-go", "glm-5.3") }).family, { codex: "openai", pi: "zhipu" })
})

test("decideReview: independence per lane and extraSameEngine", () => {
  const same = decideReview({ codex: lane("ok"), pi: piLane("openai-codex", "gpt-6.1-terra") })
  assert.deepEqual(same.independence, { codex: "model", pi: "model" })
  assert.equal(same.extraSameEngine, true)
  const cli = decideReview({ "claude-cli": lane("ok"), pi: piLane("claude-bridge", "claude-opus-5") })
  assert.deepEqual(cli.independence, { "claude-cli": "context", pi: "context" })
  assert.equal(cli.extraSameEngine, true)
  const mixed = decideReview({ codex: lane("ok"), pi: piLane("opencode-go", "glm-5.3") })
  assert.equal(mixed.extraSameEngine, false)
  assert.deepEqual(mixed.refuters, { "codex-refuter": "run", "pi-refuter": "run" })
  const unknown = decideReview({ codex: lane("ok"), pi: piLane(null, null, "failed") })
  assert.deepEqual(unknown.independence, { codex: "model", pi: "unknown" })
  assert.equal(unknown.extraSameEngine, false)
  assert.equal(decideReview({ codex: lane("ok") }).extraSameEngine, false)
  assert.equal(decideReview({ pi: piLane(null, null), "claude-cli": lane("ok") }).extraSameEngine, false)
})

const votes = (pairs) => ({ verdicts: Object.entries(pairs).map(([id, verdict]) => ballot(id, verdict)) })

test("vote: codex + pi on OpenAI, verifier refuted, both would-be refuters confirmed → unconfirmed", () => {
  const review = decideReview({ codex: lane("ok"), pi: piLane("openai-codex", "gpt-6.1-terra") })
  assert.equal(review.refuters["pi-refuter"], "skipped (same-family as codex)")
  const lanes = { "codex-refuter": lane("ok"), "pi-refuter": lane("skipped", review.refuters["pi-refuter"], []) }
  const got = decideSceptic(lanes, ["F1"], [ballot("F1", "DISAGREE_EVIDENCE")],
    { "codex-refuter": votes({ F1: "AGREE" }), "pi-refuter": null }, GUARDED)
  assert.equal(got.voteMode, "strict")
  assert.deepEqual(core(got.perFinding.F1), { decision: "unconfirmed", voters: "2 of 2", noVote: [] })
  assert.deepEqual(got.excluded, {})
})

test("vote: 3 voters, codex + pi on glm: verifier and codex confirmed, pi refuted → confirmed (2 of 3)", () => {
  const review = decideReview({ codex: lane("ok"), pi: piLane("opencode-go", "glm-5.3") })
  assert.deepEqual(review.refuters, { "codex-refuter": "run", "pi-refuter": "run" })
  const lanes = { "codex-refuter": lane("ok"), "pi-refuter": piLane("opencode-go", "glm-5.3") }
  const got = decideSceptic(lanes, ["F1"], [ballot("F1", "AGREE")],
    { "codex-refuter": votes({ F1: "AGREE" }), "pi-refuter": votes({ F1: "DISAGREE_EVIDENCE" }) }, GUARDED)
  assert.equal(got.voteMode, "strict")
  assert.deepEqual(core(got.perFinding.F1), { decision: "confirmed", voters: "3 of 3", noVote: [] })
})

test("vote: a refuter whose own run is not independent is excluded; verifier confirmed stays confirmed", () => {
  for (const [provider, model, reason] of [["claude-bridge", "claude-opus-5", "family anthropic (panel)"],
    [null, null, "family unknown"], ["openai-codex", "gpt-6.1-terra", "family openai (as codex-refuter)"]]) {
    const lanes = { "codex-refuter": lane("ok"), "pi-refuter": piLane(provider, model) }
    const got = decideSceptic(lanes, ["F1"], [ballot("F1", "AGREE")],
      { "codex-refuter": votes({}), "pi-refuter": votes({ F1: "DISAGREE_EVIDENCE" }) })
    assert.deepEqual(got.excluded, { "pi-refuter": reason })
    assert.deepEqual(core(got.perFinding.F1), { decision: "confirmed", voters: "1 of 2", noVote: ["codex-refuter"] }, reason)
  }
  // alone: voters read 1 of 1, and the mode names why
  const alone = decideSceptic({ "pi-refuter": piLane("claude-bridge", "claude-opus-5") }, ["F1"],
    [ballot("F1", "AGREE")], { "pi-refuter": votes({ F1: "DISAGREE_EVIDENCE" }) })
  assert.deepEqual(core(alone.perFinding.F1), { decision: "confirmed", voters: "1 of 1", noVote: [] })
  assert.equal(alone.voteMode, "strict → basic (no independent refuter)")
  // `kind` wins over the name
  const kinded = decideSceptic({ x: { ...lane("ok"), kind: "claude-cli" } }, ["F1"], [], { x: votes({ F1: "DISAGREE_EVIDENCE" }) })
  assert.deepEqual(kinded.excluded, { x: "family anthropic (panel)" })
})

test("decideSceptic: a same-family skip gives the independent-refuter wording, a failed refuter the plain one", () => {
  const skipped = decideSceptic({ "claude-cli-refuter": lane("skipped", "skipped (same-family)", []) }, ["F1"],
    [ballot("F1", "AGREE")], { "claude-cli-refuter": null })
  assert.equal(skipped.voteMode, "strict → basic (no independent refuter)")
  assert.deepEqual(core(skipped.perFinding.F1), { decision: "confirmed", voters: "1 of 1", noVote: [] })
  const unknown = decideSceptic({ "pi-refuter": lane("skipped", "skipped (independence unknown)", []) }, ["F1"], [], {})
  assert.equal(unknown.voteMode, "strict → basic (no independent refuter)")
  const failed = decideSceptic({ "codex-refuter": lane("degraded"), "pi-refuter": lane("skipped", "skipped (same-family as codex)", []) },
    ["F1"], [], { "codex-refuter": null })
  assert.equal(failed.voteMode, "strict → basic")
  assert.equal(decideSceptic({ "codex-refuter": lane("skipped", "skipped (unavailable)", []) }, ["F1"], [], {}).voteMode, "strict → basic")
})

test("decideSceptic: no refuter lanes at all is basic", () => {
  const basic = decideSceptic({}, ["F1"], [ballot("F1", "AGREE")], {}, GUARDED)
  assert.equal(basic.voteMode, "basic")
  assert.deepEqual(core(basic.perFinding.F1), { decision: "confirmed", voters: "1 of 1", noVote: [] })
})

// The voter sets of the outcomes table: 1 = basic, 2 = verifier + codex, 3 = verifier + codex + pi (glm).
const VOTER_LANES = [{}, { "codex-refuter": lane("ok") }, { "codex-refuter": lane("ok"), "pi-refuter": piLane("opencode-go", "glm-5.3") }]
const BAD_QUOTE = { ...CITE, quote: "if (other) return x" }
// A = AGREE, E = DISAGREE_EVIDENCE with a verifying quote, X = DISAGREE_EVIDENCE whose quote fails, C = concern.
const kindBallot = (id, k) => (k === "A" ? ballot(id, "AGREE") : k === "E" ? ballot(id, "DISAGREE_EVIDENCE")
  : k === "X" ? ballot(id, "DISAGREE_EVIDENCE", { citation: BAD_QUOTE }) : ballot(id, "DISAGREE_CONCERN"))
/** `kinds` = [verifier, codex?, pi?]; null = no vote. → the decision entry for F1. */
function sceptic(kinds, options = GUARDED) {
  const [own, ...refuters] = kinds
  const lanes = VOTER_LANES[refuters.length]
  const names = Object.keys(lanes)
  const payloads = Object.fromEntries(names.map((name, i) =>
    [name, refuters[i] ? { verdicts: [kindBallot("F1", refuters[i])] } : null]))
  return decideSceptic(lanes, ["F1"], own ? [kindBallot("F1", own)] : [], payloads, options).perFinding.F1
}

test("vote rules: every row of the outcomes table (the ballot corpus)", () => {
  const TABLE = [
    ["real", ["A"], "confirmed"],
    ["false", ["E"], "refuted"],
    ["real", ["C"], "unconfirmed"],
    ["real", ["X"], "unconfirmed"],
    ["real", ["A", "C"], "confirmed"],
    ["false", ["A", "E"], "unconfirmed"],
    ["real", ["C", "A"], "unconfirmed"],
    ["false", ["C", "E"], "unconfirmed"],
    ["false", ["E", "C"], "refuted"],
    ["real", ["E", "A"], "unconfirmed"],
    ["real", ["C", "C"], "unconfirmed"],
    ["real", ["C", "A", "A"], "confirmed"],
    ["false", ["C", "E", "E"], "refuted"],
    ["false", ["A", "E", "E"], "refuted"],
    ["false", ["A", "E", "C"], "unconfirmed"],
    ["real", ["A", "E", "A"], "confirmed"],
  ]
  for (const [label, kinds, decision] of TABLE) {
    const got = sceptic(kinds)
    assert.equal(got.decision, decision, `${label}: ${kinds.join(" + ")}`)
    assert.equal(got.voters, `${kinds.length} of ${kinds.length}`)
  }
})

const KINDS = ["A", "E", "X", "C", null]
const combos = (n) => (n === 0 ? [[]] : combos(n - 1).flatMap((rest) => KINDS.map((k) => [k, ...rest])))
const BALLOTS = [1, 2, 3].flatMap((n) => combos(n))

test("vote rules: doubt never removes a finding the verifier grounded", () => {
  for (const kinds of BALLOTS.filter(([own, ...rest]) => own === "A" && rest.every((k) => k === "C" || k === null))) {
    assert.equal(sceptic(kinds).decision, "confirmed", kinds.join(" + "))
  }
})

test("vote rules: a lone refuter AGREE never promotes a finding", () => {
  for (const kinds of BALLOTS.filter(([own, ...rest]) => own === "C" && rest.filter((k) => k === "A").length === 1)) {
    assert.notEqual(sceptic(kinds).decision, "confirmed", kinds.join(" + "))
  }
})

test("vote rules: no valid verifier vote is unconfirmed, whatever the refuters say", () => {
  for (const kinds of BALLOTS.filter(([own]) => own === null)) assert.equal(sceptic(kinds).decision, "unconfirmed", kinds.join(" + "))
  const lanes = VOTER_LANES[2]
  const all = { "codex-refuter": votes({ F1: "AGREE" }), "pi-refuter": votes({ F1: "AGREE" }) }
  for (const payload of [undefined, null, { nope: 1 }, [{ id: "F1", verdict: "maybe" }], [ballot("F1", "AGREE"), ballot("F1", "AGREE")]]) {
    assert.equal(decideSceptic(lanes, ["F1"], payload, all, GUARDED).perFinding.F1.decision, "unconfirmed", JSON.stringify(payload))
  }
})

test("vote rules: a failed refuter and an excluded same-family refuter cast no vote", () => {
  const failed = decideSceptic({ "codex-refuter": lane("degraded"), "pi-refuter": piLane("opencode-go", "glm-5.3") }, ["F1"],
    [ballot("F1", "AGREE")], { "codex-refuter": null, "pi-refuter": votes({ F1: "DISAGREE_CONCERN" }) }, GUARDED).perFinding.F1
  assert.deepEqual({ ...core(failed), votes: failed.votes },
    { decision: "confirmed", voters: "2 of 3", noVote: ["codex-refuter"], votes: { verifier: "AGREE", "pi-refuter": "DISAGREE_CONCERN" } })
  const excluded = decideSceptic({ "codex-refuter": lane("ok"), "pi-refuter": piLane("openai-codex", "gpt-6.1-terra") }, ["F1"],
    [ballot("F1", "DISAGREE_CONCERN")], { "codex-refuter": votes({ F1: "AGREE" }), "pi-refuter": votes({ F1: "AGREE" }) }, GUARDED)
  assert.deepEqual(excluded.excluded, { "pi-refuter": "family openai (as codex-refuter)" })
  assert.deepEqual(excluded.perFinding.F1.votes, { verifier: "DISAGREE_CONCERN", "codex-refuter": "AGREE" })
  assert.equal(excluded.perFinding.F1.decision, "unconfirmed") // with pi counted it would be 2 of 3 → confirmed
})

test("vote rules: a failed quote turns V A + R E into confirmed; no injected check downgrades every refutation", () => {
  assert.equal(sceptic(["A", "E"]).decision, "unconfirmed")
  const failed = sceptic(["A", "X"])
  assert.equal(failed.decision, "confirmed")
  assert.deepEqual(failed.votes, { verifier: "AGREE", "codex-refuter": "DISAGREE_CONCERN" })
  assert.deepEqual(failed.downgraded, { "codex-refuter": "quote not found" })
  const unchecked = sceptic(["E", "E"], {})
  assert.equal(unchecked.decision, "unconfirmed")
  assert.deepEqual(unchecked.downgraded, { verifier: "no citation check", "codex-refuter": "no citation check" })
  const thrown = sceptic(["A", "E"], { verifyCitation: () => { throw new Error("boom") } })
  assert.equal(thrown.decision, "confirmed")
  assert.deepEqual(thrown.downgraded, { "codex-refuter": "check failed" })
})

test("decideSceptic notes: capped free text, uncut verified quote, citation only on a verified refutation", () => {
  const quote = `GUARD ${"x".repeat(1494)}`
  const lanes = VOTER_LANES[2]
  const got = decideSceptic(lanes, ["F1"], [ballot("F1", "DISAGREE_EVIDENCE", { evidence: "e".repeat(2048), citation: { ...CITE, quote } })], {
    "codex-refuter": votes({ F1: "AGREE" }),
    "pi-refuter": { verdicts: [ballot("F1", "DISAGREE_EVIDENCE", { evidence: "bad\u0000 quote\u001b[31m\nnext", citation: BAD_QUOTE })] },
  }, GUARDED).perFinding.F1
  assert.equal(got.notes.verifier.kind, "DISAGREE_EVIDENCE")
  assert.equal(got.notes.verifier.text.length, 500)
  assert.ok(got.notes.verifier.text.endsWith("…"))
  assert.equal(got.notes.verifier.citation.quote.length, 1500)
  assert.deepEqual(got.notes.verifier.citation, { ...CITE, quote })
  assert.deepEqual(got.notes["codex-refuter"], { kind: "AGREE", text: "" })
  assert.deepEqual(got.notes["pi-refuter"], { kind: "DISAGREE_CONCERN", text: "bad quote [31m next" })
  assert.deepEqual(got.downgraded, { "pi-refuter": "quote not found" })
  const legacy = decideSceptic({}, ["F1"], [{ id: "F1", verdict: "refuted", evidence: "guarded" }], {}, GUARDED).perFinding.F1
  assert.deepEqual(legacy.notes, { verifier: { kind: "DISAGREE_CONCERN", text: "guarded" } })
  assert.deepEqual(legacy.downgraded, { verifier: "legacy refuted without citation" })
})

test("renderSceptic: language-neutral tokens; one-line concerns, quotes fenced so they cannot break out", () => {
  const LABEL = /^(\w[\w-]*: (AGREE|EVIDENCE|CONCERN)(, )?)+$/
  const fenced = "GUARD\n```\n# x\n````"
  const got = decideSceptic(VOTER_LANES[2], ["F1", "F2"], [ballot("F1", "DISAGREE_EVIDENCE", { citation: { file: "a`b.js", line: 12, quote: fenced } }),
    ballot("F2", "AGREE")], {
    "codex-refuter": votes({ F1: "DISAGREE_CONCERN" }),
    "pi-refuter": { verdicts: [ballot("F1", "DISAGREE_EVIDENCE", { citation: { ...CITE, quote: "GUARD\n# x" } }),
      ballot("F2", "DISAGREE_CONCERN", { evidence: "may leak\n\non retry" })] },
  }, GUARDED).perFinding
  assert.equal(got.F1.decision, "refuted")
  assert.equal(got.F1.label, "verifier: EVIDENCE, codex: CONCERN, pi: EVIDENCE")
  assert.equal(got.F2.label, "verifier: AGREE, pi: CONCERN")
  for (const entry of Object.values(got)) assert.match(entry.render.label, LABEL)
  assert.deepEqual(got.F2.render, { label: "verifier: AGREE, pi: CONCERN", concerns: [{ voter: "pi", text: "may leak on retry" }], refutation: null })
  const { refutation } = got.F1.render
  assert.deepEqual(refutation, { voter: "verifier", loc: "ab.js:12", quote: fenced, fence: "`````" })
  const block = `${refutation.fence}\n${refutation.quote}\n${refutation.fence}`
  assert.equal(block.split("\n").filter((line) => line.startsWith(refutation.fence)).length, 2, "the quote never closes its fence")
  const plain = renderSceptic({ decision: "refuted", label: "pi: EVIDENCE",
    notes: { "pi-refuter": { kind: "DISAGREE_EVIDENCE", text: "", citation: { ...CITE, quote: "GUARD\n# x" } } } })
  assert.deepEqual(plain.refutation, { voter: "pi", loc: "a.js:12", quote: "GUARD\n# x", fence: "```" })
  // Nothing in `render` is prose: every string is the label, a voter name, a voter's own text, a loc, a quote or a fence.
  const prose = []
  const walk = (value, key) => {
    if (typeof value === "string") {
      if (!["label", "voter", "text", "loc", "quote", "fence"].includes(key)) prose.push(`${key}: ${value}`)
      if (key === "voter") assert.match(value, /^(verifier|codex|pi|claude-cli)$/)
      if (key === "fence") assert.match(value, /^`{3,}$/)
    } else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, Array.isArray(value) ? key : k)
  }
  for (const entry of Object.values(got)) walk(entry.render, "render")
  assert.deepEqual(prose, [])
})
