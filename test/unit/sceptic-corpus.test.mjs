// Offline old-vs-new comparison of the sceptic vote rules (#8, measurement part (i)).
//
// It measures the RULES on constructed ballots only, not model behaviour: every vote below is
// written by hand. The new rule runs through the real path (`run-lane decide --phase sceptic` over a
// temp work dir, a diff and a temp repo); the old rule is the pre-#8 tallyVotes, copied below.
//
// Old-rule conversion: AGREE → confirmed; DISAGREE_EVIDENCE → refuted (quote unchecked, as before);
// DISAGREE_CONCERN → refuted for a refuter (its brief argued "NOT real") and unconfirmed for the
// verifier, so the old harm is not inflated. For a finding the verifier confirmed, converting a
// refuter concern to `refuted` changes an old outcome only with 3 voters: with 2, verifier
// `confirmed` against a refuter `refuted` or `unconfirmed` is a tie, so `unconfirmed` either way.
// (Against a verifier `refuted` it can matter with 2: see "false-verifier-guard".) "3v-concerns" is a
// 3-voter case where the conversion changes the old outcome, "3v-agree-concern" one where it does not.

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const HELPER = new URL("../../scripts/run-lane.mjs", import.meta.url).pathname

// Pre-change tallyVotes, verbatim from commit 1a48df2 (scripts/lib/lanes.mjs).
function tallyVotes(ids, ballots) {
  const perFinding = {}
  for (const id of ids) {
    const cast = Object.values(ballots).map((b) => b[id]).filter(Boolean)
    const counts = {}
    for (const v of cast) counts[v] = (counts[v] ?? 0) + 1
    const winner = Object.keys(counts).find((v) => counts[v] * 2 > cast.length)
    perFinding[id] = {
      decision: (ballots.verifier?.[id] && winner) || "unconfirmed",
      voters: `${cast.length} of ${Object.keys(ballots).length}`,
      noVote: Object.keys(ballots).filter((name) => !ballots[name][id]),
    }
  }
  return perFinding
}

const DIFF = `diff --git a/src/auth.js b/src/auth.js
index 1111111..2222222 100644
--- a/src/auth.js
+++ b/src/auth.js
@@ -1,3 +1,6 @@
 export function handle(req, user) {
+  if (!user) return deny()
+  const role = lookupRole(user)
+  if (!isAdmin(role)) return deny()
   return run(req.body.command)
 }
`
const AUTH = "export function handle(req, user) {\n  if (!user) return deny()\n  const role = lookupRole(user)\n  if (!isAdmin(role)) return deny()\n  return run(req.body.command)\n}\n"
const GUARD_JS = "// shared guard\nexport function runSafe(cmd) {\n  if (!ALLOWED.has(cmd)) throw new Error(\"denied\")\n  return exec(cmd)\n}\n"

// Citations: a correct guard quote in the diff, the same quote at a wrong line, and one outside the diff.
const GUARD = { file: "src/auth.js", line: "4", quote: "if (!isAdmin(role)) return deny()" }
const WRONG_LINE = { ...GUARD, line: "40" }
const HEAD = { file: "src/guard.js", line: 3, quote: 'if (!ALLOWED.has(cmd)) throw new Error("denied")' }

const A = { verdict: "AGREE", evidence: "src/auth.js:5 runs the command unchecked", citation: null }
const C = { verdict: "DISAGREE_CONCERN", evidence: "not sure this is reachable", citation: null }
const E = (citation) => ({ verdict: "DISAGREE_EVIDENCE", evidence: "guarded", citation })

// [name, truth, severity, verifier vote, codex-refuter vote?, pi-refuter vote?]
const CASES = [
  ["basic-real", "real", "P0", A],
  ["basic-false-guard", "false", "P0", E(GUARD)],
  ["real-vs-uncited-doubt", "real", "P1", A, C],
  ["real-vs-wrong-line", "real", "P1", A, E(WRONG_LINE)],
  ["false-verifier-guard", "false", "P1", E(GUARD), C],
  ["false-refuter-guard", "false", "P1", A, E(GUARD)],
  ["false-both-doubt", "false", "P0", C, C],
  ["lone-refuter-agree", "real", "P1", C, A],
  ["3v-concerns", "real", "P1", A, C, C],
  ["3v-agree-concern", "real", "P1", A, A, C],
  ["3v-false-guards", "false", "P1", A, E(GUARD), E(GUARD)],
  ["3v-false-head-quotes", "false", "P1", C, E(HEAD), E(HEAD)],
  ["3v-real-p0-wrong-line", "real", "P0", A, E(WRONG_LINE), C],
]

const REFUTERS = ["codex-refuter", "pi-refuter"]
const STATUS = {
  "codex-refuter": { kind: "codex" },
  "pi-refuter": { kind: "pi", provider: "opencode-go", model: "glm-5.3" },
}
const okStatus = (name) => ({ lane: name, ...STATUS[name], status: "ok", display: "ok",
  attempts: [{ n: 1, status: "ok", reason: null, rc: 0, seconds: 1 }] })
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value))

/** The new rule, through the real helper. */
function newDecision(root, [name, , , verifier, ...refuters]) {
  const wd = join(root, name)
  mkdirSync(wd)
  writeFileSync(join(wd, "diff.patch"), DIFF)
  writeJson(join(wd, "ids.json"), ["F1"])
  writeJson(join(wd, "verifier.verdicts.json"), [{ id: "F1", ...verifier, suggested_severity: null }])
  const lanes = REFUTERS.slice(0, refuters.length)
  lanes.forEach((lane, i) => {
    writeJson(join(wd, `${lane}.status.json`), okStatus(lane))
    writeJson(join(wd, `${lane}.json`), { verdicts: [{ id: "F1", ...refuters[i], suggested_severity: null }] })
  })
  const run = spawnSync(process.execPath, [HELPER, "decide", "--wd", wd, "--phase", "sceptic", "--lanes", lanes.join(","),
    "--repo", join(root, "repo"), "--head-sha", "worktree"], { encoding: "utf8" })
  assert.equal(run.status, 0, run.stderr)
  return JSON.parse(readFileSync(join(wd, "sceptic.decision.json"), "utf8")).perFinding.F1.decision
}

const OLD_WORD = { AGREE: "confirmed", DISAGREE_EVIDENCE: "refuted" }
const oldWord = (vote, concern) => OLD_WORD[vote.verdict] ?? concern

/** The old rule over the same ballots, converted to the old vocabulary; `refuterConcern` is the conversion. */
function oldDecision([, , , verifier, ...refuters], refuterConcern = "refuted") {
  const ballots = { verifier: { F1: oldWord(verifier, "unconfirmed") } }
  refuters.forEach((vote, i) => { ballots[REFUTERS[i]] = { F1: oldWord(vote, refuterConcern) } })
  return tallyVotes(["F1"], ballots).F1.decision
}

/** real kept = confirmed; a false P1 dropped = refuted; a false P0 is moved to Unverified unless confirmed. */
function score(rows, key) {
  const real = rows.filter((r) => r.truth === "real")
  const falseP1 = rows.filter((r) => r.truth === "false" && r.severity === "P1")
  const falseP0 = rows.filter((r) => r.truth === "false" && r.severity === "P0")
  return {
    realKept: real.filter((r) => r[key] === "confirmed").length,
    falseP1Dropped: falseP1.filter((r) => r[key] === "refuted").length,
    falseP0Unverified: falseP0.filter((r) => r[key] !== "confirmed").length,
  }
}

test("sceptic corpus: old vs new vote rule on constructed ballots", () => {
  const root = mkdtempSync(join(tmpdir(), "sceptic-corpus-"))
  try {
    mkdirSync(join(root, "repo", "src"), { recursive: true })
    writeFileSync(join(root, "repo", "src", "auth.js"), AUTH)
    writeFileSync(join(root, "repo", "src", "guard.js"), GUARD_JS)
    const rows = CASES.map((c) => ({ name: c[0], truth: c[1], severity: c[2], voters: c.length - 3,
      old: oldDecision(c), new: newDecision(root, c) }))
    console.log(["case | truth | sev | voters | old | new", ...rows.map((r) =>
      `${r.name} | ${r.truth} | ${r.severity} | ${r.voters} | ${r.old} | ${r.new}`)].join("\n"))

    assert.deepEqual(Object.fromEntries(rows.map((r) => [r.name, [r.old, r.new]])), {
      "basic-real": ["confirmed", "confirmed"],
      "basic-false-guard": ["refuted", "refuted"],
      "real-vs-uncited-doubt": ["unconfirmed", "confirmed"],
      "real-vs-wrong-line": ["unconfirmed", "confirmed"],
      "false-verifier-guard": ["refuted", "refuted"],
      "false-refuter-guard": ["unconfirmed", "unconfirmed"],
      "false-both-doubt": ["unconfirmed", "unconfirmed"],
      "lone-refuter-agree": ["unconfirmed", "unconfirmed"],
      "3v-concerns": ["refuted", "confirmed"],
      "3v-agree-concern": ["confirmed", "confirmed"],
      "3v-false-guards": ["refuted", "refuted"],
      "3v-false-head-quotes": ["refuted", "refuted"],
      "3v-real-p0-wrong-line": ["refuted", "confirmed"],
    })
    assert.deepEqual(score(rows, "old"), { realKept: 2, falseP1Dropped: 3, falseP0Unverified: 2 })
    assert.deepEqual(score(rows, "new"), { realKept: 6, falseP1Dropped: 3, falseP0Unverified: 2 })

    // For a verifier-confirmed finding the conversion of a refuter concern matters only with 3 voters.
    const asUnconfirmed = (c) => oldDecision(c, "unconfirmed")
    const byName = Object.fromEntries(CASES.map((c) => [c[0], c]))
    assert.notEqual(asUnconfirmed(byName["3v-concerns"]), oldDecision(byName["3v-concerns"]))
    assert.equal(asUnconfirmed(byName["3v-agree-concern"]), oldDecision(byName["3v-agree-concern"]))
    for (const c of CASES.filter((c) => c.length === 5 && c[3] === A)) assert.equal(asUnconfirmed(c), oldDecision(c), c[0])
    assert.notEqual(asUnconfirmed(byName["false-verifier-guard"]), oldDecision(byName["false-verifier-guard"]))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
