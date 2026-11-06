// Process tests for scripts/run-lane.mjs: the real helper against fake `codex`/`pi`/`claude` binaries on
// PATH (test/fixtures/fake-lane.mjs). T=1 throughout; the time bounds come from the plan's
// arithmetic table plus a generous margin for process start-up.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validStatus } from "../../scripts/lib/lanes.mjs"
import { makeReadHeadFile } from "../../scripts/lib/quote-check.mjs"
import { buildVerifyCitation } from "../../scripts/run-lane.mjs"
import { planLenses } from "../../scripts/lenses.mjs"

const ROOT = new URL("../..", import.meta.url).pathname
const HELPER = join(ROOT, "scripts/run-lane.mjs")
const FAKE = join(ROOT, "test/fixtures/fake-lane.mjs")
const CRASH = join(ROOT, "test/fixtures/crash-run-lane.mjs")

function workspace(bins = ["codex", "pi", "claude"]) {
  const dir = mkdtempSync(join(tmpdir(), "run-lane-"))
  const bin = join(dir, "bin")
  const repo = join(dir, "repo")
  mkdirSync(bin)
  mkdirSync(repo)
  for (const name of bins) {
    writeFileSync(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" ${name} "$@"\n`)
    chmodSync(join(bin, name), 0o755)
  }
  writeFileSync(join(dir, "brief.txt"), "Review the diff.")
  writeFileSync(join(dir, "ids.json"), '["F1","F2"]')
  return { dir, bin, repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Launch the helper (or `script`), resolving { code, seconds, proc } once it exits. */
function launch(ws, argv, { script = HELPER, fake = "ok", onStart, env = {} } = {}) {
  const started = performance.now()
  const proc = spawn(process.execPath, [script, ...argv], {
    stdio: "ignore",
    env: { ...process.env, PATH: `${ws.bin}:${process.env.PATH}`, FAKE_DIR: ws.dir, FAKE_SCRIPT: fake, ...env },
  })
  onStart?.(proc)
  return new Promise((resolve) => proc.on("exit", (code) => resolve({ code, seconds: (performance.now() - started) / 1000 })))
}

const runArgs = (ws, lane, extra = []) =>
  ["run", lane, "--wd", ws.dir, "--repo", ws.repo, "--brief-file", join(ws.dir, "brief.txt"), "--timeout", "1", ...extra]
// Every status the helper really writes must pass the shape check `decide` applies to it.
const status = (ws, name = "codex") => {
  const s = JSON.parse(readFileSync(join(ws.dir, `${name}.status.json`), "utf8"))
  assert.ok(validStatus(s, name), `helper wrote a status decide would reject: ${JSON.stringify(s)}`)
  return s
}
const launches = (ws, name = "codex") => (existsSync(join(ws.dir, `${name}.count`)) ? Number(readFileSync(join(ws.dir, `${name}.count`), "utf8")) : 0)
const pid = (ws, file) => Number(readFileSync(join(ws.dir, file), "utf8"))
const alive = (p) => {
  try {
    process.kill(p, 0)
    return true
  } catch {
    return false
  }
}
async function assertDead(...pids) {
  for (let i = 0; i < 100 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 20))
  for (const p of pids) assert.equal(alive(p), false, `pid ${p} outlived its attempt`)
}
async function waitFor(path) {
  for (let i = 0; i < 250 && !existsSync(path); i++) await new Promise((r) => setTimeout(r, 20))
  assert.ok(existsSync(path), `${path} never appeared`)
}
const decide = (ws, phase, lanes) => launch(ws, ["decide", "--wd", ws.dir, "--phase", phase, "--lanes", lanes])
const decision = (ws, phase) => JSON.parse(readFileSync(join(ws.dir, `${phase}.decision.json`), "utf8"))
const core = ({ decision, voters, noVote }) => ({ decision, voters, noVote })

test("1: fail then ok → ok (retried: failed), canonical output written", async () => {
  const ws = workspace()
  try {
    await launch(ws, runArgs(ws, "codex"), { fake: "fail,ok" })
    const s = status(ws)
    assert.equal(s.display, "ok (retried: failed)")
    assert.deepEqual(s.attempts.map((a) => a.status), ["failed", "ok"])
    assert.equal(s.attempts[0].reason, "stream disconnected")
    assert.deepEqual(JSON.parse(readFileSync(join(ws.dir, "codex.json"), "utf8")), { findings: [] })
    assert.ok(existsSync(join(ws.dir, "codex.a1.log")) && existsSync(join(ws.dir, "codex.a2.json")))
    assert.equal(launches(ws), 2)
  } finally {
    ws.cleanup()
  }
})

test("1a: a finding's lens survives codex and pi into the canonical output", async () => {
  for (const lane of ["codex", "pi"]) {
    const ws = workspace()
    try {
      await launch(ws, runArgs(ws, lane), { fake: "lens" })
      assert.equal(status(ws, lane).display, "ok")
      const out = JSON.parse(readFileSync(join(ws.dir, `${lane}.json`), "utf8"))
      assert.equal(out.findings[0].lens, "payments", lane)
    } finally {
      ws.cleanup()
    }
  }
})

test("1b: pi runs in the repo cwd and reports its model", async () => {
  const ws = workspace()
  try {
    await launch(ws, runArgs(ws, "pi"))
    const s = status(ws, "pi")
    assert.equal(s.display, "ok")
    assert.equal(s.model, "gemini-test")
    assert.equal(s.provider, "google")
    assert.equal(readFileSync(join(ws.dir, "pi.1.cwd"), "utf8"), ws.repo)
    assert.deepEqual(JSON.parse(readFileSync(join(ws.dir, "pi.json"), "utf8")), { findings: [] })
  } finally {
    ws.cleanup()
  }
})

test("1c: pi-refuter fail then votes → ok (retried: failed), verdicts written", async () => {
  const ws = workspace()
  try {
    await launch(ws, runArgs(ws, "pi", ["--name", "pi-refuter", "--require-key", "verdicts",
      "--ids-file", join(ws.dir, "ids.json")]), { fake: "fail,votes" })
    assert.equal(status(ws, "pi-refuter").display, "ok (retried: failed)")
    const out = JSON.parse(readFileSync(join(ws.dir, "pi-refuter.json"), "utf8"))
    assert.deepEqual(out.verdicts.map((v) => [v.id, v.verdict]), [["F1", "refuted"]])
  } finally {
    ws.cleanup()
  }
})

test("every attempt records startedAt; codex status records model (null when unset) and the effective schema", async () => {
  const ws = workspace()
  try {
    const before = Date.now()
    await launch(ws, runArgs(ws, "codex"), { fake: "fail,ok" })
    const s = status(ws)
    assert.equal(s.attempts.length, 2)
    for (const a of s.attempts) {
      assert.equal(new Date(a.startedAt).toISOString(), a.startedAt, "startedAt is an ISO timestamp")
      assert.ok(Date.parse(a.startedAt) >= before - 1000)
    }
    assert.ok(Date.parse(s.attempts[1].startedAt) >= Date.parse(s.attempts[0].startedAt))
    assert.equal(s.model, null)
    assert.equal(s.schema, join(ROOT, "contracts/finding.schema.json"), "the default schema when --schema is not given")
  } finally {
    ws.cleanup()
  }
  const ws2 = workspace()
  try {
    const schema = join(ROOT, "contracts/verdict.schema.json")
    await launch(ws2, runArgs(ws2, "codex", ["--model", "gpt-x", "--schema", schema]))
    const s = status(ws2)
    assert.equal(s.model, "gpt-x")
    assert.equal(s.schema, schema)
    assert.ok(s.attempts[0].startedAt)
  } finally {
    ws2.cleanup()
  }
})

test("2: invalid_json_schema → failed: <reason>, exactly one launch", async () => {
  const ws = workspace()
  try {
    await launch(ws, runArgs(ws, "codex"), { fake: "schema,ok" })
    assert.equal(status(ws).display, "failed: invalid_json_schema: bad")
    assert.equal(launches(ws), 1)
    assert.equal(existsSync(join(ws.dir, "codex.json")), false)
  } finally {
    ws.cleanup()
  }
})

test("3a: timeout with TERM honoured, then ok → ok (retried: timeout) within 2T", async () => {
  const ws = workspace()
  try {
    const { seconds } = await launch(ws, runArgs(ws, "codex"), { fake: "sleep,ok" })
    assert.equal(status(ws).display, "ok (retried: timeout)")
    assert.ok(seconds < 2 + 0.75, `took ${seconds}s`)
  } finally {
    ws.cleanup()
  }
})

test("3b: attempt 1 ignores TERM → degraded (timeout; no time left), child and grandchild dead", async () => {
  // T=2, g=0.5 (= T/4, not clamped): KILL at 2.5, t2 = min(2, 4 − 2.5 − 0.5) = 1 − ε < min(30, T/2) = 1
  const ws = workspace()
  try {
    const { seconds } = await launch(ws, runArgs(ws, "codex", ["--timeout", "2", "--kill-grace", "0.5"]), { fake: "ignore,ok" })
    assert.equal(status(ws).display, "degraded (timeout; no time left)")
    assert.equal(launches(ws), 1)
    assert.ok(seconds < 2.5 + 0.75, `took ${seconds}s`)
    await assertDead(pid(ws, "codex.1.pid"), pid(ws, "codex.1.gc"))
  } finally {
    ws.cleanup()
  }
})

test("3b': --kill-grace above T/4 is clamped to T/4", async () => {
  // T=1, --kill-grace 0.9 → effective 0.25: KILL lands at ~1.25s, not 1.9s
  const ws = workspace()
  try {
    await launch(ws, runArgs(ws, "codex", ["--kill-grace", "0.9"]), { fake: "ignore,ok" })
    const [a1] = status(ws).attempts
    assert.equal(a1.status, "timeout")
    assert.ok(a1.seconds >= 1.25 && a1.seconds < 1.6, `attempt 1 took ${a1.seconds}s`)
  } finally {
    ws.cleanup()
  }
})

test("3c: timeout, then attempt 2 ignores TERM → degraded (timeout; timeout), phase ≤ 2T + 0.5s", async () => {
  const ws = workspace()
  try {
    const { seconds } = await launch(ws, runArgs(ws, "codex"), { fake: "sleep,ignore" })
    const s = status(ws)
    assert.equal(s.display, "degraded (timeout; timeout)")
    const inHelper = s.attempts.reduce((sum, a) => sum + a.seconds, 0)
    assert.ok(inHelper <= 2.5, `attempts took ${inHelper}s`)
    assert.ok(seconds <= 2.5 + 0.5, `helper took ${seconds}s`)
    await assertDead(pid(ws, "codex.2.pid"), pid(ws, "codex.2.gc"))
  } finally {
    ws.cleanup()
  }
})

test("4: SIGTERM to the helper → exit 143, group dead, no status; decide → helper error", async () => {
  const ws = workspace()
  try {
    const done = launch(ws, runArgs(ws, "codex", ["--timeout", "10"]), {
      fake: "hang",
      onStart: async (proc) => {
        await waitFor(join(ws.dir, "codex.1.gc"))
        proc.kill("SIGTERM")
      },
    })
    assert.equal((await done).code, 143)
    await assertDead(pid(ws, "codex.1.pid"), pid(ws, "codex.1.gc"))
    assert.equal(existsSync(join(ws.dir, "codex.status.json")), false)
    await decide(ws, "review", "codex")
    const { display, kind, brief, requestedModel } = decision(ws, "review").lanes.codex
    assert.deepEqual({ display, kind, brief, requestedModel },
      { display: "failed: helper error (no status written)", kind: "codex", brief: null, requestedModel: null })
  } finally {
    ws.cleanup()
  }
})

test("4b: a crash inside the helper still kills the group and writes no status", async () => {
  const ws = workspace()
  try {
    const { code } = await launch(ws, runArgs(ws, "codex", ["--timeout", "10"]), { script: CRASH, fake: "hang" })
    assert.notEqual(code, 0)
    await assertDead(pid(ws, "codex.1.pid"), pid(ws, "codex.1.gc"))
    assert.equal(existsSync(join(ws.dir, "codex.status.json")), false)
  } finally {
    ws.cleanup()
  }
})

test("4c: a grandchild left behind by a clean exit is killed on settle", async () => {
  const ws = workspace()
  try {
    await launch(ws, runArgs(ws, "codex"), { fake: "orphan" })
    assert.equal(status(ws).display, "ok")
    await assertDead(pid(ws, "codex.1.gc"))
  } finally {
    ws.cleanup()
  }
})

test("4d: --from-decision missing, invalid or without an entry → helper error, zero launches", async () => {
  const ws = workspace()
  try {
    const path = join(ws.dir, "review.decision.json")
    const args = runArgs(ws, "codex", ["--name", "codex-refuter", "--from-decision", path])
    for (const content of [null, "{broken", '{"refuters":{}}']) {
      if (content !== null) writeFileSync(path, content)
      await launch(ws, args)
      const { display, kind, brief, requestedModel } = status(ws, "codex-refuter")
      // The helper error keeps the run's own facts: a known brief is not overwritten with null.
      assert.deepEqual({ display, kind, brief, requestedModel },
        { display: "failed: helper error (no review decision)", kind: "codex", brief: "brief.txt", requestedModel: null })
    }
    assert.equal(launches(ws), 0)
  } finally {
    ws.cleanup()
  }
})

test("--skip: unavailable and other reasons, no launch", async () => {
  const ws = workspace()
  try {
    await launch(ws, runArgs(ws, "codex", ["--skip", "unavailable"]))
    await launch(ws, runArgs(ws, "pi", ["--skip", "extra=off"]))
    assert.equal(status(ws).display, "unavailable")
    assert.equal(status(ws, "pi").display, "skipped (extra=off)")
    assert.equal(launches(ws) + launches(ws, "pi"), 0)
    await decide(ws, "review", "codex,pi")
    assert.equal(decision(ws, "review").allExternalDown, true)
  } finally {
    ws.cleanup()
  }
})

test("review.decision.json is write-once: a second decide keeps the first decision", async () => {
  const ws = workspace()
  try {
    await launch(ws, runArgs(ws, "codex"))
    await decide(ws, "review", "codex")
    const first = readFileSync(join(ws.dir, "review.decision.json"), "utf8")
    rmSync(join(ws.dir, "codex.status.json"))
    const { code } = await decide(ws, "review", "codex")
    assert.equal(code, 0)
    assert.equal(readFileSync(join(ws.dir, "review.decision.json"), "utf8"), first)
    assert.equal(decision(ws, "review").lanes.codex.display, "ok")
  } finally {
    ws.cleanup()
  }
})

/** §5 → §8 as the command runs it: the review lane, `decide`, then the refuter via the decision. */
async function handoff(ws, fake, reviewExtra = []) {
  await launch(ws, runArgs(ws, "codex", reviewExtra), { fake })
  await decide(ws, "review", "codex")
  await launch(ws, runArgs(ws, "codex", ["--name", "codex-refuter", "--require-key", "verdicts",
    "--ids-file", join(ws.dir, "ids.json"), "--from-decision", join(ws.dir, "review.decision.json")]), { fake })
  return status(ws, "codex-refuter")
}

test("5: §5 → §8 handoff launches a refuter only where the decision says run", async (t) => {
  await t.test("config-failed codex → refuter skipped, never launched", async () => {
    const ws = workspace()
    try {
      assert.equal((await handoff(ws, "schema,votes")).display, "skipped (codex failed: config)")
      assert.equal(launches(ws), 1)
    } finally {
      ws.cleanup()
    }
  })
  await t.test("degraded codex → refuter launched", async () => {
    const ws = workspace()
    try {
      assert.equal((await handoff(ws, "fail,fail,votes")).display, "ok")
      assert.equal(launches(ws), 3)
      assert.equal(readFileSync(join(ws.dir, "codex.3.cwd"), "utf8"), ws.repo)
    } finally {
      ws.cleanup()
    }
  })
  await t.test("unavailable codex → refuter skipped, never launched", async () => {
    const ws = workspace()
    try {
      assert.equal((await handoff(ws, "votes", ["--skip", "unavailable"])).display, "skipped (unavailable)")
      assert.equal(launches(ws), 0)
    } finally {
      ws.cleanup()
    }
  })
  await t.test("refuter fail,fail + verifier verdicts → voteMode strict → basic, verifier decides", async () => {
    const ws = workspace()
    try {
      assert.equal((await handoff(ws, "ok,fail,fail")).display, "degraded (failed: stream disconnected; failed: stream disconnected)")
      writeFileSync(join(ws.dir, "verifier.verdicts.json"), JSON.stringify([
        { id: "F1", verdict: "confirmed", evidence: "a.js:1", suggested_severity: null },
        { id: "F2", verdict: "refuted", evidence: "a.js:2", suggested_severity: null },
      ]))
      await decide(ws, "sceptic", "codex-refuter")
      const d = decision(ws, "sceptic")
      assert.equal(d.voteMode, "strict → basic")
      assert.equal(d.verifier, "ok")
      // a legacy `refuted` without a citation is a concern now: F2 is no longer refuted on its word alone
      assert.deepEqual(core(d.perFinding.F1), { decision: "confirmed", voters: "1 of 2", noVote: ["codex-refuter"] })
      assert.deepEqual(core(d.perFinding.F2), { decision: "unconfirmed", voters: "1 of 2", noVote: ["codex-refuter"] })
      assert.deepEqual(d.perFinding.F2.downgraded, { verifier: "legacy refuted without citation" })
    } finally {
      ws.cleanup()
    }
  })
  await t.test("refuter that votes counts in the tally", async () => {
    const ws = workspace()
    try {
      await handoff(ws, "ok,votes")
      writeFileSync(join(ws.dir, "verifier.verdicts.json"), JSON.stringify([{ id: "F1", verdict: "confirmed", evidence: "" }]))
      await decide(ws, "sceptic", "codex-refuter")
      const d = decision(ws, "sceptic")
      assert.equal(d.voteMode, "strict")
      // the fake refuter's uncited legacy `refuted` is a concern, so V AGREE + R CONCERN survives
      assert.deepEqual(core(d.perFinding.F1), { decision: "confirmed", voters: "2 of 2", noVote: [] })
      assert.equal(d.perFinding.F1.label, "verifier: AGREE, codex: CONCERN")
      // the refuter's attempt record keeps the ids it was not asked about
      assert.deepEqual(status(ws, "codex-refuter").attempts[0].ignored, [])
    } finally {
      ws.cleanup()
    }
  })
})

test("basic: decide --phase sceptic --lanes \"\" tallies the verifier alone, voteMode basic", async () => {
  const ws = workspace()
  try {
    writeFileSync(join(ws.dir, "verifier.verdicts.json"), JSON.stringify([
      { id: "F1", verdict: "AGREE", evidence: "a.js:1", citation: null, suggested_severity: null },
      { id: "F2", verdict: "DISAGREE_CONCERN", evidence: "unsure", citation: null, suggested_severity: null },
    ]))
    await decide(ws, "sceptic", "")
    const d = decision(ws, "sceptic")
    assert.equal(d.voteMode, "basic")
    assert.deepEqual(core(d.perFinding.F1), { decision: "confirmed", voters: "1 of 1", noVote: [] })
    assert.deepEqual(core(d.perFinding.F2), { decision: "unconfirmed", voters: "1 of 1", noVote: [] })
  } finally {
    ws.cleanup()
  }
})

test("MAJOR 1: sceptic decide covers every sent id when the verifier is missing or partial", async () => {
  const ws = workspace()
  try {
    await handoff(ws, "ok,votes") // codex-refuter votes refuted on F1 only; ids.json = F1, F2
    await decide(ws, "sceptic", "codex-refuter")
    const missing = decision(ws, "sceptic")
    assert.equal(missing.verifier, "missing")
    assert.deepEqual(core(missing.perFinding.F1), { decision: "unconfirmed", voters: "1 of 2", noVote: ["verifier"] }) // a refuter never decides alone
    assert.deepEqual(core(missing.perFinding.F2), { decision: "unconfirmed", voters: "0 of 2", noVote: ["verifier", "codex-refuter"] })
    writeFileSync(join(ws.dir, "verifier.verdicts.json"), JSON.stringify([{ id: "F1", verdict: "refuted", evidence: "" }]))
    await decide(ws, "sceptic", "codex-refuter")
    const partial = decision(ws, "sceptic")
    assert.equal(partial.verifier, "ok")
    // both votes are uncited legacy `refuted`, so both are concerns: no quote, no refutation
    assert.deepEqual(core(partial.perFinding.F1), { decision: "unconfirmed", voters: "2 of 2", noVote: [] })
    assert.deepEqual(core(partial.perFinding.F2), { decision: "unconfirmed", voters: "0 of 2", noVote: ["verifier", "codex-refuter"] })
    rmSync(join(ws.dir, "ids.json"))
    await decide(ws, "sceptic", "codex-refuter")
    assert.equal(decision(ws, "sceptic").error, "failed: helper error (no ids)")
  } finally {
    ws.cleanup()
  }
})

test("MAJOR 2: a verdict run without valid sent ids fails closed and launches nothing", async () => {
  const ws = workspace()
  try {
    const ids = join(ws.dir, "ids.json")
    const args = runArgs(ws, "codex", ["--name", "codex-refuter", "--require-key", "verdicts", "--ids-file", ids])
    for (const content of [null, "{broken", "[]"]) {
      if (content === null) rmSync(ids)
      else writeFileSync(ids, content)
      await launch(ws, args, { fake: "votes" })
      assert.equal(status(ws, "codex-refuter").display, "failed: helper error (no ids)", String(content))
    }
    assert.equal(launches(ws), 0)
  } finally {
    ws.cleanup()
  }
})

test("a refuter answering only unknown ids is unparseable, and the ignored ids are recorded", async () => {
  const ws = workspace()
  try {
    writeFileSync(join(ws.dir, "ids.json"), '["F7"]')
    await launch(ws, runArgs(ws, "codex", ["--name", "codex-refuter", "--require-key", "verdicts",
      "--ids-file", join(ws.dir, "ids.json")]), { fake: "votes,votes" })
    const s = status(ws, "codex-refuter")
    assert.equal(s.display, "degraded (unparseable; unparseable)")
    assert.deepEqual(s.attempts.map((a) => a.ignored), [["F1"], ["F1"]])
  } finally {
    ws.cleanup()
  }
})

test("a decision entry or status that breaks the contract is a helper error", async () => {
  const ws = workspace()
  try {
    const path = join(ws.dir, "review.decision.json")
    writeFileSync(path, JSON.stringify({ refuters: { "codex-refuter": "maybe" } }))
    await launch(ws, runArgs(ws, "codex", ["--name", "codex-refuter", "--require-key", "verdicts",
      "--ids-file", join(ws.dir, "ids.json"), "--from-decision", path]))
    assert.equal(status(ws, "codex-refuter").display, "failed: helper error (no review decision)")
    assert.equal(launches(ws), 0)
    for (const bad of [
      { lane: "codex", status: "ok", display: "ok" },
      { lane: "pi", status: "ok", display: "ok", attempts: [{ n: 1, status: "ok", reason: null, rc: 0, seconds: 1 }] },
      { lane: "codex", status: "ok", display: "ok", attempts: [{ n: 1, status: "ok", reason: null, rc: 0 }] },
      { lane: "codex", status: "ok", display: "ok", attempts: [] },
      { lane: "codex", status: "degraded", display: "d", attempts: [{ status: "timeout" }] },
    ]) {
      writeFileSync(join(ws.dir, "codex.status.json"), JSON.stringify(bad))
      rmSync(join(ws.dir, "review.decision.json"), { force: true }) // write-once: start each case fresh
      await decide(ws, "review", "codex")
      assert.equal(decision(ws, "review").lanes.codex.display, "failed: helper error (no status written)", JSON.stringify(bad))
    }
  } finally {
    ws.cleanup()
  }
})

const argv = (ws, name, n) => JSON.parse(readFileSync(join(ws.dir, `${name}.${n}.argv`), "utf8"))
const flag = (args, f) => args[args.indexOf(f) + 1]

test("claude-cli ok: repo cwd, --add-dir <wd>, effective model and the status facts", async () => {
  const ws = workspace()
  try {
    await launch(ws, runArgs(ws, "claude-cli"), { env: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s1" } })
    const s = status(ws, "claude-cli")
    assert.equal(s.display, "ok")
    assert.deepEqual([s.kind, s.brief, s.requestedModel, s.model], ["claude-cli", "brief.txt", null, "claude-sonnet-5-5"])
    assert.equal(s.schema, join(ROOT, "contracts/finding.schema.json"))
    assert.deepEqual(JSON.parse(readFileSync(join(ws.dir, "claude-cli.json"), "utf8")), { findings: [] })
    assert.equal(readFileSync(join(ws.dir, "claude.1.cwd"), "utf8"), ws.repo)
    const args = argv(ws, "claude", 1)
    assert.equal(flag(args, "--add-dir"), ws.dir)
    assert.equal(flag(args, "--model"), "sonnet")
    // the nested claude must not join the calling Claude Code session
    assert.deepEqual(JSON.parse(readFileSync(join(ws.dir, "claude.1.env"), "utf8")), { CLAUDECODE: null, CLAUDE_CODE_SESSION_ID: null })
  } finally {
    ws.cleanup()
  }
})

test("claude-cli: prose then ok → ok (retried: unparseable); config → one launch; timeout retried", async () => {
  for (const [fake, display, count] of [
    ["prose,ok", "ok (retried: unparseable)", 2],
    ["config,ok", /^failed: There's an issue with the selected model/, 1],
    ["sleep,ok", "ok (retried: timeout)", 2],
  ]) {
    const ws = workspace()
    try {
      await launch(ws, runArgs(ws, "claude-cli"), { fake })
      const s = status(ws, "claude-cli")
      if (typeof display === "string") assert.equal(s.display, display, fake)
      else assert.match(s.display, display, fake)
      assert.equal(launches(ws, "claude"), count, fake)
    } finally {
      ws.cleanup()
    }
  }
})

test("claude-cli refuter: verdict schema by default, votes counted", async () => {
  const ws = workspace()
  try {
    await launch(ws, runArgs(ws, "claude-cli", ["--name", "claude-cli-refuter", "--require-key", "verdicts",
      "--ids-file", join(ws.dir, "ids.json"), "--model", "opus"]), { fake: "votes" })
    const s = status(ws, "claude-cli-refuter")
    assert.equal(s.display, "ok")
    assert.equal(s.schema, join(ROOT, "contracts/verdict.schema.json"))
    assert.equal(s.requestedModel, "opus")
    assert.equal(flag(argv(ws, "claude", 1), "--model"), "opus")
  } finally {
    ws.cleanup()
  }
})

test("--skip unavailable --skip-reason r → unavailable (r), facts recorded", async () => {
  const ws = workspace()
  try {
    await launch(ws, runArgs(ws, "pi", ["--skip", "unavailable", "--skip-reason", "forced, not installed"]))
    const s = status(ws, "pi")
    assert.deepEqual([s.status, s.display, s.kind, s.brief], ["unavailable", "unavailable (forced, not installed)", "pi", "brief.txt"])
    assert.equal(launches(ws, "pi"), 0)
  } finally {
    ws.cleanup()
  }
})

/** `run-lane select` with only `bins` on PATH; returns { code, out, stderr }. */
function select(ws, args = [], env = {}) {
  const r = spawnSync(process.execPath, [HELPER, "select", ...args], {
    encoding: "utf8", env: { ...process.env, PATH: ws.bin, FAKE_DIR: ws.dir, ...env },
  })
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, stderr: r.stderr }
}
const lanesOf = (out) => out.lanes.map((l) => [l.name, l.model, l.skip, l.skipReason])

test("select: the cascade over installed subsets, a forced consultant, extra and a listing failure", () => {
  for (const [bins, args, env, lanes, listed] of [
    [[], [], {}, [["codex", null, "unavailable", null]], false],
    [["codex", "pi", "claude"], [], {}, [["codex", null, null, null]], false],
    [["pi", "claude"], [], {}, [["pi", "openai-codex/gpt-6.1-terra", null, null]], true],
    [["claude"], [], {}, [["claude-cli", "sonnet", null, null]], false],
    [["pi", "claude"], [], { FAKE_PI_LIST: "fail" }, [["claude-cli", "sonnet", null, null]], true],
    [["codex", "claude"], ["--consultant", "pi"], {}, [["pi", null, "unavailable", "forced, not installed"]], false],
    [["codex", "pi"], ["--consultant", "claude-cli"], {}, [["claude-cli", null, "unavailable", "forced, not installed"]], false],
    [["codex", "pi"], ["--extra"], {}, [["codex", null, null, null], ["pi", "opencode-go/glm-5.3", null, null]], true],
    [["codex", "pi"], ["--extra", "--pi-model", "x/y"], {}, [["codex", null, null, null], ["pi", "x/y", null, null]], false],
    [["pi"], ["--consultant", "pi"], { FAKE_PI_LIST: "fail" }, [["pi", null, "unavailable", "pi --list-models failed"]], true],
  ]) {
    const ws = workspace(bins)
    try {
      const r = select(ws, args, env)
      const label = JSON.stringify([bins, args, env])
      assert.equal(r.code, 0, `${label}: ${r.stderr}`)
      assert.deepEqual(lanesOf(r.out), lanes, label)
      assert.equal(typeof r.out.reason, "string")
      assert.equal(existsSync(join(ws.dir, "pi.list")), listed, `${label}: pi --list-models run only when needed`)
      // The catalog must match what a run can use: a run loads no extensions, so neither does the listing.
      if (listed) assert.deepEqual(JSON.parse(readFileSync(join(ws.dir, "pi.list"), "utf8")), ["--no-extensions", "--list-models"], label)
      assert.equal(existsSync(join(ws.dir, "consultants.json")), false, "without --wd nothing is written")
    } finally {
      ws.cleanup()
    }
  }
})

test("select --wd writes consultants.json as printed; an unknown consultant is a usage error", () => {
  const ws = workspace()
  try {
    const r = select(ws, ["--wd", ws.dir, "--consultant", "pi", "--extra"])
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(JSON.parse(readFileSync(join(ws.dir, "consultants.json"), "utf8")), r.out)
    assert.equal(r.out.extraNote, "skipped (pi is the consultant)")
    const bad = select(ws, ["--consultant", "opencode"])
    assert.equal(bad.code, 2)
    assert.equal(bad.out, null)
    assert.match(bad.stderr, /unknown consultant "opencode"/)
  } finally {
    ws.cleanup()
  }
})

// ── §2 gate: settings.json (plan issue-7-profiles, tests G1–G4; G3 is the case above) ──────────
const SETTINGS_SCRIPT = join(ROOT, "scripts/settings.mjs")
const settingsCli = (...args) => spawnSync(process.execPath, [SETTINGS_SCRIPT, ...args], { encoding: "utf8" })

/** ws.repo as a git repo with a committed release profile; $WD gets args.txt and an empty diff. */
function profiledWorkspace() {
  const ws = workspace()
  const git = (...args) => execFileSync("git", args, { cwd: ws.repo })
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "t")
  mkdirSync(join(ws.repo, ".consensus-review/profiles"), { recursive: true })
  writeFileSync(join(ws.repo, ".consensus-review/profiles/release.md"), "---\nsceptic: basic\n---\n")
  git("add", "-A")
  git("commit", "-q", "-m", "init")
  writeFileSync(join(ws.dir, "args.txt"), "profile=release")
  writeFileSync(join(ws.dir, "diff.patch"), "")
  assert.equal(settingsCli("resolve", "--wd", ws.dir, "--args-file", join(ws.dir, "args.txt")).status, 0)
  return ws
}

test("G1: select refuses a pending profile and writes no consultants.json", () => {
  const ws = profiledWorkspace()
  try {
    const r = select(ws, ["--wd", ws.dir])
    assert.equal(r.code, 2)
    assert.equal(r.stderr, "profile release was not applied (run settings.mjs profile first)\n")
    assert.equal(existsSync(join(ws.dir, "consultants.json")), false)
  } finally {
    ws.cleanup()
  }
})

test("G2: after settings.mjs profile, select runs and writes consultants.json", () => {
  const ws = profiledWorkspace()
  try {
    const applied = settingsCli("profile", "--wd", ws.dir, "--repo", ws.repo)
    assert.equal(applied.status, 0, applied.stderr)
    const r = select(ws, ["--wd", ws.dir])
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(JSON.parse(readFileSync(join(ws.dir, "consultants.json"), "utf8")), r.out)
  } finally {
    ws.cleanup()
  }
})

for (const text of ["{not json", "[]", "null"]) {
  test(`G4: a settings.json of ${text} fails closed`, () => {
    const ws = workspace()
    try {
      writeFileSync(join(ws.dir, "settings.json"), text)
      const r = select(ws, ["--wd", ws.dir])
      assert.equal(r.code, 2)
      assert.equal(r.stderr, "settings.json unreadable\n")
      assert.equal(existsSync(join(ws.dir, "consultants.json")), false)
    } finally {
      ws.cleanup()
    }
  })
}

/** Runs every lane of consultants.json as §5 does, then decides the review. */
async function runSelected(ws, fake) {
  const { lanes } = JSON.parse(readFileSync(join(ws.dir, "consultants.json"), "utf8"))
  for (const l of lanes) {
    const extra = ["--brief-file", join(ws.dir, "brief.txt"), ...(l.model ? ["--model", l.model] : []),
      ...(l.skip ? ["--skip", l.skip, "--skip-reason", l.skipReason ?? ""] : [])]
    await launch(ws, runArgs(ws, l.name, extra), { fake })
  }
  await decide(ws, "review", lanes.map((l) => l.name).join(","))
  return lanes
}

test("primary pi plus extra: one pi lane through run and decide, its status kept", async () => {
  const ws = workspace(["pi", "claude"])
  try {
    assert.equal(select(ws, ["--wd", ws.dir, "--extra"]).code, 0)
    const lanes = await runSelected(ws)
    assert.deepEqual(lanes.map((l) => l.name), ["pi"])
    assert.equal(launches(ws, "pi"), 1)
    const d = decision(ws, "review")
    assert.deepEqual(Object.keys(d.lanes), ["pi"])
    assert.deepEqual(Object.keys(d.refuters), ["pi-refuter"])
    const s = status(ws, "pi")
    assert.deepEqual([s.display, s.requestedModel, s.provider, s.model], ["ok", "openai-codex/gpt-6.1-terra", "google", "gemini-test"])
  } finally {
    ws.cleanup()
  }
})

test("--model handoff: select → run pi → run pi --name pi-refuter, the selected model both times", async () => {
  for (const [args, model] of [[[], "openai-codex/gpt-6.1-terra"], [["--pi-model", "opencode-go/qwen3.8-max"], "opencode-go/qwen3.8-max"]]) {
    const ws = workspace(["pi"])
    try {
      assert.equal(select(ws, ["--wd", ws.dir, "--consultant", "pi", ...args]).code, 0)
      const [lane] = await runSelected(ws, "ok,votes")
      assert.equal(lane.model, model)
      await launch(ws, runArgs(ws, "pi", ["--name", "pi-refuter", "--model", lane.model, "--require-key", "verdicts",
        "--ids-file", join(ws.dir, "ids.json"), "--from-decision", join(ws.dir, "review.decision.json")]), { fake: "ok,votes" })
      assert.equal(status(ws, "pi-refuter").display, "ok")
      assert.equal(status(ws, "pi-refuter").requestedModel, model)
      assert.deepEqual([1, 2].map((n) => flag(argv(ws, "pi", n), "--model")), [model, model])
    } finally {
      ws.cleanup()
    }
  }
})

/** A repo with commits base and head; the guard exists only at head; HEAD is checked out at base. */
function quoteRepo() {
  const dir = mkdtempSync(join(tmpdir(), "quote-repo-"))
  const repo = join(dir, "repo")
  mkdirSync(repo)
  const git = (...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" }).stdout.trim()
  git("init", "-q")
  git("config", "user.email", "t@t")
  git("config", "user.name", "t")
  writeFileSync(join(repo, "app.js"), "export const app = 1\n")
  git("add", ".")
  git("commit", "-qm", "base")
  const base = git("rev-parse", "HEAD")
  writeFileSync(join(repo, "guard.js"), "// guard\nexport function guard(user) {\n  if (!isAdmin(user)) return deny()\n}\n")
  git("add", ".")
  git("commit", "-qm", "head")
  const head = git("rev-parse", "HEAD")
  git("checkout", "-q", base)
  writeFileSync(join(dir, "diff.patch"), `diff --git a/app.js b/app.js
--- a/app.js
+++ b/app.js
@@ -1,1 +1,2 @@
 export const app = 1
+export const checkedValue = validate(app)
`)
  return { dir, repo, base, head, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const GUARD = { file: "guard.js", line: "3", quote: "if (!isAdmin(user)) return deny()" }
const NEW_SIDE = { file: "app.js", line: "2", quote: "export const checkedValue = validate(app)" }

test("decide --phase sceptic: --head-sha <head> blob-reads a file outside the diff; <base> does not", () => {
  const r = quoteRepo()
  try {
    const at = (sha) => buildVerifyCitation({ wd: r.dir, repo: r.repo, "head-sha": sha })
    assert.deepEqual(at(r.head)(GUARD), { verified: true, reason: null, source: "head" })
    assert.equal(at(r.base)(GUARD).verified, false)
    assert.equal(at(r.base)(GUARD).reason, "file not readable at head")
    assert.equal(at(r.head)(NEW_SIDE).source, "diff")
  } finally {
    r.cleanup()
  }
})

test("decide --phase sceptic: absent, empty, 'abc' or a missing 40-hex --head-sha → no clone reads", () => {
  const r = quoteRepo()
  try {
    for (const sha of [undefined, "", "abc", r.head.toUpperCase(), "0".repeat(40)]) {
      assert.equal(makeReadHeadFile({ repo: r.repo, headSha: sha }), null, String(sha))
      const verify = buildVerifyCitation({ wd: r.dir, repo: r.repo, "head-sha": sha })
      assert.equal(verify(GUARD).reason, "cannot verify outside diff", String(sha))
    }
    assert.equal(makeReadHeadFile({ headSha: r.head }), null)
  } finally {
    r.cleanup()
  }
})

test("decide --phase sceptic: worktree reads the working file, never through ../, an absolute path or a symlink out", () => {
  const r = quoteRepo()
  try {
    const verify = buildVerifyCitation({ wd: r.dir, repo: r.repo, "head-sha": "worktree" })
    assert.equal(verify(GUARD).reason, "file not readable at head")
    writeFileSync(join(r.repo, "guard.js"), "// guard\n  if (!isAdmin(user)) return deny()\n")
    assert.equal(verify(GUARD).source, "head")
    writeFileSync(join(r.dir, "outside.js"), "  if (!isAdmin(user)) return deny()\n")
    symlinkSync(join(r.dir, "outside.js"), join(r.repo, "leak.js"))
    const read = makeReadHeadFile({ repo: r.repo, headSha: "worktree" })
    assert.equal(read("leak.js"), null)
    assert.equal(read("../outside.js"), null)
    assert.equal(read(join(r.dir, "outside.js")), null)
    assert.equal(verify({ ...GUARD, file: "leak.js", line: "1" }).verified, false)
    assert.equal(verify({ ...GUARD, file: "../outside.js", line: "1" }).reason, "unsafe path")
  } finally {
    r.cleanup()
  }
})

test("decide --phase sceptic: diff-only (no --repo, no --head-sha) verifies only new-side quotes", () => {
  const r = quoteRepo()
  try {
    const verify = buildVerifyCitation({ wd: r.dir })
    assert.equal(verify(NEW_SIDE).source, "diff")
    assert.equal(verify(GUARD).reason, "cannot verify outside diff")
    const explicit = buildVerifyCitation({ wd: r.dir, diff: join(r.dir, "missing.patch") })
    assert.equal(explicit(NEW_SIDE).reason, "cannot verify outside diff")
  } finally {
    r.cleanup()
  }
})

test("decide --phase sceptic accepts --repo, --diff and --head-sha", async () => {
  const ws = workspace()
  const r = quoteRepo()
  try {
    const { code } = await launch(ws, ["decide", "--wd", ws.dir, "--phase", "sceptic", "--lanes", "codex-refuter",
      "--repo", r.repo, "--diff", join(r.dir, "diff.patch"), "--head-sha", r.head])
    assert.equal(code, 0)
    assert.ok(decision(ws, "sceptic").perFinding)
  } finally {
    r.cleanup()
    ws.cleanup()
  }
})

// T7: --lenses-file appends the rendered lenses to the brief; the fake records the prompt as its last argv.
const prompt = (ws, name) => argv(ws, name, 1).at(-1)
const lensRun = async (ws, lane, lensFile) => {
  const extra = lensFile === undefined ? [] : ["--lenses-file", join(ws.dir, lensFile)]
  return launch(ws, runArgs(ws, lane, extra))
}

test("T7.1: --lenses-file → prompt is brief + blank line + lens text; status names the file", async () => {
  const ws = workspace()
  try {
    writeFileSync(join(ws.dir, "lenses-consultant.md"), "L")
    await lensRun(ws, "codex", "lenses-consultant.md")
    assert.equal(prompt(ws, "codex"), "Review the diff.\n\nL")
    assert.equal(status(ws).lenses, "lenses-consultant.md")
  } finally {
    ws.cleanup()
  }
})

test("T7.2: a rendered consultant lens file ends the prompt with the fixed trailer", async () => {
  const ws = workspace()
  try {
    const { texts } = planLenses({
      records: [{ name: "payments", text: "check it", include: ["src/payments/**"], exclude: [], source: "lens",
        dimension: "impact", file: ".consensus-review/lenses/payments.md" }],
      d5Paths: [], matchPaths: ["src/payments/charge.js"], dims: ["impact"],
    })
    writeFileSync(join(ws.dir, "lenses-consultant.md"), texts.consultant)
    await lensRun(ws, "codex", "lenses-consultant.md")
    assert.equal(prompt(ws, "codex").split("\n").at(-1),
      "End of project lenses. Your output format above (the schema, any required markers) is unchanged.")
  } finally {
    ws.cleanup()
  }
})

test("T7.3: pi keeps its marker brief, then the lenses, and its output still parses ok", async () => {
  const ws = workspace()
  try {
    const brief = "Review the diff.\nAnswer between ===FINDINGS_START=== and ===FINDINGS_END===."
    writeFileSync(join(ws.dir, "brief.txt"), brief)
    writeFileSync(join(ws.dir, "lenses-consultant.md"), "<project_lenses>\nL\n</project_lenses>\nTRAILER")
    await lensRun(ws, "pi", "lenses-consultant.md")
    assert.equal(prompt(ws, "pi"), `${brief}\n\n<project_lenses>\nL\n</project_lenses>\nTRAILER`)
    assert.equal(status(ws, "pi").status, "ok")
  } finally {
    ws.cleanup()
  }
})

test("T7.4: a missing lenses file runs the lane on the brief alone, status lenses:missing", async () => {
  const ws = workspace()
  try {
    await lensRun(ws, "codex", "lenses-consultant.md")
    const s = status(ws)
    assert.equal(s.status, "ok")
    assert.equal(s.lenses, "missing")
    assert.equal(prompt(ws, "codex"), "Review the diff.")
  } finally {
    ws.cleanup()
  }
})

test("T7.5: no --lenses-file → prompt is the brief, status lenses:null", async () => {
  const ws = workspace()
  try {
    await lensRun(ws, "codex")
    assert.equal(prompt(ws, "codex"), "Review the diff.")
    assert.equal(status(ws).lenses, null)
  } finally {
    ws.cleanup()
  }
})
