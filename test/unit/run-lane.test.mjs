// Process tests for scripts/run-lane.mjs: the real helper against fake `codex`/`pi` binaries on
// PATH (test/fixtures/fake-lane.mjs). T=1 throughout; the time bounds come from the plan's
// arithmetic table plus a generous margin for process start-up.

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validStatus } from "../../scripts/lib/lanes.mjs"

const ROOT = new URL("../..", import.meta.url).pathname
const HELPER = join(ROOT, "scripts/run-lane.mjs")
const FAKE = join(ROOT, "test/fixtures/fake-lane.mjs")
const CRASH = join(ROOT, "test/fixtures/crash-run-lane.mjs")

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "run-lane-"))
  const bin = join(dir, "bin")
  const repo = join(dir, "repo")
  mkdirSync(bin)
  mkdirSync(repo)
  for (const name of ["codex", "pi"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" ${name} "$@"\n`)
    chmodSync(join(bin, name), 0o755)
  }
  writeFileSync(join(dir, "brief.txt"), "Review the diff.")
  writeFileSync(join(dir, "ids.json"), '["F1","F2"]')
  return { dir, bin, repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Launch the helper (or `script`), resolving { code, seconds, proc } once it exits. */
function launch(ws, argv, { script = HELPER, fake = "ok", onStart } = {}) {
  const started = performance.now()
  const proc = spawn(process.execPath, [script, ...argv], {
    stdio: "ignore",
    env: { ...process.env, PATH: `${ws.bin}:${process.env.PATH}`, FAKE_DIR: ws.dir, FAKE_SCRIPT: fake },
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

test("1b: pi runs in the repo cwd and reports its model", async () => {
  const ws = workspace()
  try {
    await launch(ws, runArgs(ws, "pi"))
    const s = status(ws, "pi")
    assert.equal(s.display, "ok")
    assert.equal(s.model, "m1")
    assert.equal(s.provider, "fake")
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
    assert.equal(decision(ws, "review").lanes.codex.display, "failed: helper error (no status written)")
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
      assert.equal(status(ws, "codex-refuter").display, "failed: helper error (no review decision)")
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
    await launch(ws, runArgs(ws, "pi", ["--skip", "no extra-advisor"]))
    assert.equal(status(ws).display, "unavailable")
    assert.equal(status(ws, "pi").display, "skipped (no extra-advisor)")
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
      assert.deepEqual(d.perFinding, {
        F1: { decision: "confirmed", voters: "1 of 2", noVote: ["codex-refuter"] },
        F2: { decision: "refuted", voters: "1 of 2", noVote: ["codex-refuter"] },
      })
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
      assert.deepEqual(d.perFinding.F1, { decision: "unconfirmed", voters: "2 of 2", noVote: [] })
      // the refuter's attempt record keeps the ids it was not asked about
      assert.deepEqual(status(ws, "codex-refuter").attempts[0].ignored, [])
    } finally {
      ws.cleanup()
    }
  })
})

test("MAJOR 1: sceptic decide covers every sent id when the verifier is missing or partial", async () => {
  const ws = workspace()
  try {
    await handoff(ws, "ok,votes") // codex-refuter votes refuted on F1 only; ids.json = F1, F2
    await decide(ws, "sceptic", "codex-refuter")
    const missing = decision(ws, "sceptic")
    assert.equal(missing.verifier, "missing")
    assert.deepEqual(missing.perFinding, {
      F1: { decision: "unconfirmed", voters: "1 of 2", noVote: ["verifier"] }, // a refuter never decides alone
      F2: { decision: "unconfirmed", voters: "0 of 2", noVote: ["verifier", "codex-refuter"] },
    })
    writeFileSync(join(ws.dir, "verifier.verdicts.json"), JSON.stringify([{ id: "F1", verdict: "refuted", evidence: "" }]))
    await decide(ws, "sceptic", "codex-refuter")
    const partial = decision(ws, "sceptic")
    assert.equal(partial.verifier, "ok")
    assert.deepEqual(partial.perFinding.F1, { decision: "refuted", voters: "2 of 2", noVote: [] })
    assert.deepEqual(partial.perFinding.F2, { decision: "unconfirmed", voters: "0 of 2", noVote: ["verifier", "codex-refuter"] })
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
