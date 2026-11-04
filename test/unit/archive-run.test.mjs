// Process tests for scripts/archive-run.mjs: the real CLI against a fake $WD, in temp git repos
// under os.tmpdir() with `.reviews/` ignored.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, relative } from "node:path"
import { SCHEMA } from "../../scripts/lib/archive.mjs"

const ROOT = new URL("../..", import.meta.url).pathname
const CLI = join(ROOT, "scripts/archive-run.mjs")
const DIFF = "diff --git a/x.js b/x.js\n+bad()\n"

function workspace(gitignore = ".reviews/\n") {
  const base = mkdtempSync(join(tmpdir(), "archive-run-"))
  const top = join(base, "repo")
  const wd = join(base, "tmp.WD1")
  mkdirSync(top)
  mkdirSync(wd)
  execFileSync("git", ["init", "-q", top])
  if (gitignore != null) writeFileSync(join(top, ".gitignore"), gitignore)
  return { base, top, wd, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

const put = (wd, files) => {
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(wd, name), typeof value === "string" ? value : JSON.stringify(value))
  }
}

const attempt = (n, status, startedAt, seconds = 1) => ({ n, startedAt, status, reason: status === "ok" ? null : "bad json", rc: 0, seconds })
const synthesis = {
  findings: [
    { id: "F1", title: "a", severity: "P2", dimension: "quality", source: "claude" },
    { id: "F2", title: "b", severity: "P0", dimension: "impact", source: "codex" },
  ],
}

/** The arbiter files plus a consultant panel: codex `unparseable,ok`, pi ok, both refuters. */
function fullRun(wd, { strict = true } = {}) {
  put(wd, {
    "diff.patch": DIFF,
    "brief.md": "codex brief",
    "brief-pi.md": "pi brief",
    "codex.a1.log": "attempt 1 prose, not json",
    "codex.a2.log": "attempt 2 log",
    "codex.a2.json": { findings: [{ title: "b", severity: "P0", dimension: "impact" }] },
    "codex.json": { findings: [{ title: "b", severity: "P0", dimension: "impact" }] },
    "codex.status.json": {
      lane: "codex", kind: "codex", brief: "brief.md", status: "ok", display: "ok (retried: unparseable)", model: "gpt-x", schema: "/s.json",
      attempts: [attempt(1, "unparseable", "2026-01-01T00:00:01.000Z"), attempt(2, "ok", "2026-01-01T00:00:03.000Z")],
    },
    "pi.a1.log": "pi raw output",
    "pi.json": { findings: [{ title: "c", severity: "P2", dimension: "tests" }] },
    "pi.status.json": { lane: "pi", kind: "pi", brief: "brief-pi.md", status: "ok", display: "ok", model: "m1", provider: "fake", attempts: [attempt(1, "ok", "2026-01-01T00:00:02.000Z")] },
    "review.decision.json": { lanes: {}, allExternalDown: false, refuters: { "codex-refuter": "run" } },
    "triage.json": { tier: "T2", dims: ["impact", "quality"], basis: "small change" },
    "claude-findings.json": { findings: [{ title: "a", severity: "P2", dimension: "quality", owner: "impact" }] },
    "synthesis.json": synthesis,
    "verifier.verdicts.json": [{ id: "F2", verdict: "confirmed", evidence: "x.js:1" }],
  })
  if (!strict) return
  put(wd, {
    "ids.json": ["F2"],
    "refuter-brief.md": "refute these",
    "refuter-brief-pi.md": "refute these, pi",
    "codex-refuter.a1.log": "refuter log",
    "codex-refuter.a1.json": { verdicts: [{ id: "F2", verdict: "confirmed", evidence: "y" }] },
    "codex-refuter.status.json": { lane: "codex-refuter", kind: "codex", brief: "refuter-brief.md", status: "ok", display: "ok", model: null, schema: "/v.json", attempts: [attempt(1, "ok", "2026-01-01T00:01:00.000Z")] },
    "pi-refuter.a1.log": "pi refuter raw",
    // no `brief`/`kind`: a status from before they were recorded, so the prompt comes from the fallback
    "pi-refuter.status.json": { lane: "pi-refuter", status: "ok", display: "ok", attempts: [attempt(1, "ok", "2026-01-01T00:01:00.000Z")] },
    "sceptic.decision.json": { lanes: {}, voteMode: "strict", verifier: "ok", perFinding: { F2: { decision: "confirmed", voters: "3 of 3", noVote: [] } } },
  })
}

function finish(cwd, args) {
  const r = spawnSync(process.execPath, [CLI, "finish", ...args], { cwd, encoding: "utf8" })
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, stderr: r.stderr }
}

/** Every file under `dir`, relative and sorted. */
const tree = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile()).map((d) => relative(dir, join(d.parentPath, d.name))).sort()
const readJson = (dir, rel) => JSON.parse(readFileSync(join(dir, rel), "utf8"))

test("a strict run is archived per the mapping, under the cwd repo even when the report is elsewhere", (t) => {
  const w = workspace()
  t.after(w.cleanup)
  fullRun(w.wd)
  const report = join(w.base, "elsewhere", "pr-7.md")
  const flags = { sceptic: "strict", "extra-advisor": true, target: "#7", mode: "PR" }
  const r = finish(w.top, ["--wd", w.wd, "--report", report, "--args-json", JSON.stringify(flags)])
  assert.equal(r.code, 0, r.stderr)
  assert.ok(r.out.dir.startsWith(join(w.top, ".reviews", "pr-7-")), r.out.dir)
  assert.equal(existsSync(join(w.base, "elsewhere")), false)
  assert.deepEqual(tree(r.out.dir), [
    "decisions/ids.json", "decisions/review.decision.json", "decisions/sceptic.decision.json",
    "diff.patch", "events.jsonl",
    "findings/claude.json", "findings/panel.json", "findings/synthesis.json", "findings/verification.json",
    "meta.json",
    "sources/arbiter/command.md",
    "sources/codex-refuter/attempt-1.log", "sources/codex-refuter/output-a1.json", "sources/codex-refuter/prompt.md", "sources/codex-refuter/status.json",
    "sources/codex/attempt-1.log", "sources/codex/attempt-2.log", "sources/codex/output-a2.json", "sources/codex/prompt.md", "sources/codex/status.json",
    "sources/finding-verifier/output.json",
    "sources/pi-refuter/attempt-1.log", "sources/pi-refuter/prompt.md", "sources/pi-refuter/status.json",
    "sources/pi/attempt-1.log", "sources/pi/prompt.md", "sources/pi/status.json",
  ])
  const dir = r.out.dir
  assert.equal(readFileSync(join(dir, "diff.patch"), "utf8"), DIFF)
  assert.equal(readFileSync(join(dir, "sources/codex/prompt.md"), "utf8"), "codex brief")
  assert.equal(readFileSync(join(dir, "sources/codex/attempt-1.log"), "utf8"), "attempt 1 prose, not json")
  assert.equal(readFileSync(join(dir, "sources/pi/attempt-1.log"), "utf8"), "pi raw output")
  assert.equal(readFileSync(join(dir, "sources/pi/prompt.md"), "utf8"), "pi brief")
  assert.equal(readFileSync(join(dir, "sources/codex-refuter/prompt.md"), "utf8"), "refute these")
  assert.equal(readFileSync(join(dir, "sources/pi-refuter/prompt.md"), "utf8"), "refute these, pi", "fallback by kind")
  assert.equal(readFileSync(join(dir, "sources/arbiter/command.md"), "utf8"), readFileSync(join(ROOT, "commands/consensus-review.md"), "utf8"))

  const panel = readJson(dir, "findings/panel.json").findings
  assert.deepEqual(panel.map((f) => [f.source, f.title]), [["codex", "b"], ["pi", "c"], ["claude", "a"]])
  const verification = readJson(dir, "findings/verification.json")
  assert.equal(verification.mode, "strict")
  assert.deepEqual(verification.findings.map((f) => [f.id, f.verdict]), [["F1", null], ["F2", "confirmed"]])
  assert.equal(verification.findings[1].voters, "3 of 3")

  const meta = readJson(dir, "meta.json")
  assert.equal(meta.schema, SCHEMA)
  assert.equal(meta.runId, basename(dir))
  assert.equal(meta.command, "consensus-review")
  assert.equal(meta.target, "#7")
  assert.equal(meta.mode, "PR")
  assert.equal(meta.pluginVersion, readJson(ROOT, ".claude-plugin/plugin.json").version)
  assert.equal(meta.report, report)
  assert.deepEqual(meta.flags, flags)
  assert.equal(meta.diffHash, createHash("sha256").update(DIFF).digest("hex").slice(0, 16))
  assert.ok(!Number.isNaN(Date.parse(meta.createdAt)))
  assert.deepEqual(meta.missing, [])
  assert.deepEqual(meta.notWritten, {})
  assert.deepEqual(meta.transcribed.sort(), ["events.jsonl:triage", "findings/claude.json", "findings/synthesis.json", "sources/finding-verifier/output.json"])
  assert.deepEqual(meta.unavailable.map((u) => u.source), ["impact-reviewer", "quality-reviewer", "finding-verifier"])
  assert.ok(meta.unavailable.every((u) => u.reason === "host does not expose the Task prompt/transcript"))
  assert.deepEqual(meta.lanes.codex, { status: "ok", display: "ok (retried: unparseable)", model: "gpt-x", provider: null, schema: "/s.json" })
  assert.equal(meta.lanes.pi.provider, "fake")

  const events = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  const codex = events.filter((e) => e.source === "codex")
  assert.deepEqual(codex.filter((e) => e.type === "attempt.finish").map((e) => e.status), ["unparseable", "ok"])
  assert.equal(codex.filter((e) => e.type === "retry").length, 1)
  assert.deepEqual(events.filter((e) => e.type === "triage").map((e) => e.tier), ["T2"])
  assert.deepEqual(events.filter((e) => e.type === "decide").map((e) => e.source).sort(), ["review", "sceptic"])
  // the archive is the only thing in the repo besides .gitignore
  assert.equal(execFileSync("git", ["-C", w.top, "status", "--porcelain"], { encoding: "utf8" }), "?? .gitignore\n")
})

test("basic: verification.json joins verifier.verdicts.json to F2; dimension agents fall back to claude-findings", (t) => {
  const w = workspace()
  t.after(w.cleanup)
  fullRun(w.wd, { strict: false })
  put(w.wd, { "triage.json": { tier: "T2", basis: "no dims" } })
  const r = finish(w.top, ["--wd", w.wd, "--report", "r.md", "--args-json", '{"sceptic":"basic"}'])
  assert.equal(r.code, 0, r.stderr)
  const verification = readJson(r.out.dir, "findings/verification.json")
  assert.equal(verification.mode, "basic")
  const f2 = verification.findings.find((f) => f.id === "F2")
  assert.deepEqual([f2.verdict, f2.evidence, f2.title], ["confirmed", "x.js:1", "b"])
  const meta = readJson(r.out.dir, "meta.json")
  assert.deepEqual(meta.missing, [], "basic does not expect ids.json")
  assert.deepEqual(meta.unavailable.map((u) => u.source), ["quality-reviewer", "finding-verifier"])
})

test("misaligned ids: verification.json is not written and meta.notWritten says why", (t) => {
  for (const [label, files] of [
    ["basic, verdict for an unknown id", { "verifier.verdicts.json": [{ id: "F9", verdict: "confirmed", evidence: "" }] }],
    ["strict, ids.json not in synthesis", { "ids.json": ["F2", "F7"], "sceptic.decision.json": { perFinding: { F2: { decision: "confirmed" }, F7: { decision: "refuted" } } } }],
  ]) {
    const w = workspace()
    t.after(w.cleanup)
    fullRun(w.wd, { strict: false })
    put(w.wd, files)
    const r = finish(w.top, ["--wd", w.wd, "--report", "r.md", "--args-json", "{}"])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(existsSync(join(r.out.dir, "findings/verification.json")), false, label)
    assert.match(readJson(r.out.dir, "meta.json").notWritten["findings/verification.json"], /ids not in synthesis\.json: F[79]/, label)
  }
})

test("duplicate or invalid ids in synthesis.json: verification.json is not written and meta.notWritten says why", (t) => {
  for (const [label, findings, reason] of [
    ["duplicate", [{ id: "F2", severity: "P0" }, { id: "F2", severity: "P1" }, { id: "F1" }], "duplicate ids in synthesis.json: F2"],
    ["empty and non-string", [{ id: "" }, { id: 7 }, { title: "no id" }, { id: "F2" }], 'invalid ids in synthesis.json: "", 7, null'],
  ]) {
    const w = workspace()
    t.after(w.cleanup)
    fullRun(w.wd, { strict: false })
    put(w.wd, { "synthesis.json": { findings } })
    const r = finish(w.top, ["--wd", w.wd, "--report", "r.md", "--args-json", "{}"])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(existsSync(join(r.out.dir, "findings/verification.json")), false, label)
    assert.equal(readJson(r.out.dir, "meta.json").notWritten["findings/verification.json"], reason, label)
  }
})

test("duplicate ids in verifier.verdicts.json: verification.json is not written", (t) => {
  const w = workspace()
  t.after(w.cleanup)
  fullRun(w.wd, { strict: false })
  put(w.wd, { "verifier.verdicts.json": [{ id: "F2", verdict: "refuted", evidence: "" }, { id: "F2", verdict: "confirmed", evidence: "" }] })
  const r = finish(w.top, ["--wd", w.wd, "--report", "r.md", "--args-json", "{}"])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(existsSync(join(r.out.dir, "findings/verification.json")), false)
  assert.equal(readJson(r.out.dir, "meta.json").notWritten["findings/verification.json"], "duplicate ids in verifier.verdicts.json: F2")
})

test("a claude-cli run: its prompt, attempts and findings in the panel, consultants.json in decisions", (t) => {
  const w = workspace()
  t.after(w.cleanup)
  put(w.wd, {
    "diff.patch": DIFF,
    "brief.md": "claude-cli brief",
    "consultants.json": { lanes: [{ name: "claude-cli", brief: "brief.md", refuterBrief: "refuter-brief.md", model: "sonnet", skip: null, skipReason: null }], extraNote: null, reason: "claude-cli: no other consultant usable" },
    "claude-cli.a1.log": "stream-json",
    "claude-cli.json": { findings: [{ title: "d", severity: "P1", dimension: "impact" }] },
    "claude-cli.status.json": {
      lane: "claude-cli", kind: "claude-cli", brief: "brief.md", requestedModel: null, status: "ok", display: "ok",
      model: "claude-sonnet-5-5", schema: "/s.json", attempts: [attempt(1, "ok", "2026-01-01T00:00:02.000Z")],
    },
    "claude-cli-refuter.status.json": {
      lane: "claude-cli-refuter", kind: "claude-cli", brief: "refuter-brief.md", status: "skipped", display: "skipped (same-family)", attempts: [],
    },
    "triage.json": { tier: "T1", dims: ["impact"] },
    "claude-findings.json": { findings: [{ title: "a", severity: "P2", dimension: "impact" }] },
    "synthesis.json": { findings: [] },
  })
  const r = finish(w.top, ["--wd", w.wd, "--report", "r.md", "--args-json", "{}"])
  assert.equal(r.code, 0, r.stderr)
  const dir = r.out.dir
  const files = tree(dir)
  for (const f of ["decisions/consultants.json", "sources/claude-cli/prompt.md", "sources/claude-cli/attempt-1.log",
    "sources/claude-cli/status.json", "sources/claude-cli-refuter/status.json"]) assert.ok(files.includes(f), f)
  assert.equal(files.includes("sources/claude-cli-refuter/prompt.md"), false, "refuter-brief.md was never written")
  assert.equal(readFileSync(join(dir, "sources/claude-cli/prompt.md"), "utf8"), "claude-cli brief")
  assert.deepEqual(readJson(dir, "findings/panel.json").findings.map((f) => [f.source, f.title]), [["claude-cli", "d"], ["claude", "a"]])
  const meta = readJson(dir, "meta.json")
  assert.deepEqual(meta.missing, [])
  assert.equal(meta.lanes["claude-cli"].model, "claude-sonnet-5-5")
})

test("each lane's prompt file is expected: brief.md, brief-pi.md and the refuter briefs that ran", (t) => {
  const w = workspace()
  t.after(w.cleanup)
  // T0: the arbiter alone, no consultant statuses.
  put(w.wd, { "diff.patch": DIFF, "triage.json": { tier: "T0", dims: [] }, "claude-findings.json": { findings: [] }, "synthesis.json": { findings: [] } })
  let meta = readJson(finish(w.top, ["--wd", w.wd, "--report", "r.md", "--args-json", "{}"]).out.dir, "meta.json")
  assert.deepEqual(meta.missing, [])
  put(w.wd, { "codex.status.json": { lane: "codex", status: "ok", display: "ok", attempts: [] } })
  meta = readJson(finish(w.top, ["--wd", w.wd, "--report", "r2.md", "--args-json", "{}"]).out.dir, "meta.json")
  assert.deepEqual(meta.missing, ["brief.md"], "a status without brief falls back by kind")
  rmSync(join(w.wd, "codex.status.json"))
  put(w.wd, { "pi.status.json": { lane: "pi", kind: "pi", brief: "brief-pi.md", status: "ok", display: "ok", attempts: [] } })
  meta = readJson(finish(w.top, ["--wd", w.wd, "--report", "r3.md", "--args-json", "{}"]).out.dir, "meta.json")
  assert.deepEqual(meta.missing, ["brief-pi.md"], "pi expects its own prompt, not brief.md")
  put(w.wd, { "brief-pi.md": "pi brief" })
  meta = readJson(finish(w.top, ["--wd", w.wd, "--report", "r3b.md", "--args-json", "{}"]).out.dir, "meta.json")
  assert.deepEqual(meta.missing, [])
  put(w.wd, { "claude-cli.status.json": { lane: "claude-cli", kind: "claude-cli", brief: "brief.md", status: "unavailable", display: "unavailable", attempts: [] } })
  meta = readJson(finish(w.top, ["--wd", w.wd, "--report", "r4.md", "--args-json", "{}"]).out.dir, "meta.json")
  assert.deepEqual(meta.missing, ["brief.md"])
  // A refuter that ran expects its brief; a skipped one never had one written.
  put(w.wd, {
    "pi-refuter.status.json": { lane: "pi-refuter", kind: "pi", brief: "refuter-brief-pi.md", status: "failed", display: "failed: x", attempts: [] },
    "codex-refuter.status.json": { lane: "codex-refuter", kind: "codex", brief: "refuter-brief.md", status: "skipped", display: "skipped (x)", attempts: [] },
  })
  meta = readJson(finish(w.top, ["--wd", w.wd, "--report", "r5.md", "--args-json", "{}"]).out.dir, "meta.json")
  assert.deepEqual(meta.missing, ["brief.md", "refuter-brief-pi.md"])
})

test("salvage without --report: run-id salvage-<WD basename>-<ts>; an empty WD lists every expected file as missing", (t) => {
  const w = workspace()
  t.after(w.cleanup)
  const r = finish(w.top, ["--wd", w.wd])
  assert.equal(r.code, 0, r.stderr)
  assert.match(basename(r.out.dir), /^salvage-tmp\.WD1-\d{8}T\d{6}Z$/)
  const meta = readJson(r.out.dir, "meta.json")
  assert.deepEqual(meta.missing, ["diff.patch", "triage.json", "claude-findings.json", "synthesis.json"], "no codex lane ran, so no brief.md is expected")
  assert.equal(meta.report, null)
  assert.deepEqual(meta.flags, {})
  assert.equal(meta.diffHash, null)
  assert.deepEqual(meta.unavailable, [])
  assert.equal(meta.notWritten["findings/verification.json"], "no synthesis.json")
})

test("a sceptic run that wrote no verdicts lists ids.json and verifier.verdicts.json as missing", (t) => {
  const w = workspace()
  t.after(w.cleanup)
  put(w.wd, { "synthesis.json": synthesis })
  const r = finish(w.top, ["--wd", w.wd, "--report", "r.md", "--args-json", "{}"])
  const meta = readJson(r.out.dir, "meta.json")
  assert.ok(meta.missing.includes("ids.json") && meta.missing.includes("verifier.verdicts.json"))
  assert.equal(meta.notWritten["findings/verification.json"], "the sceptic did not run")
})

test("--off, cwd not a repo, and a destination that is not ignored: skipped, nothing created", (t) => {
  const w = workspace()
  t.after(w.cleanup)
  fullRun(w.wd)
  assert.deepEqual(finish(w.top, ["--wd", w.wd, "--report", "r.md", "--args-json", "{}", "--off"]), { code: 0, out: { skipped: "archive=off" }, stderr: "" })
  assert.equal(existsSync(join(w.top, ".reviews")), false)

  const norepo = mkdtempSync(join(tmpdir(), "archive-run-norepo-"))
  t.after(() => rmSync(norepo, { recursive: true, force: true }))
  assert.deepEqual(finish(norepo, ["--wd", w.wd, "--report", "r.md"]).out, { skipped: "not in a git worktree" })
  assert.deepEqual(readdirSync(norepo), [])

  const open = workspace(".reviews/*.md\n")
  t.after(open.cleanup)
  fullRun(open.wd)
  const r = finish(open.top, ["--wd", open.wd, "--report", "r.md"])
  assert.equal(r.code, 0)
  assert.deepEqual(r.out, { skipped: ".reviews/ is not gitignored as a directory" })
  assert.deepEqual(readdirSync(open.top).sort(), [".git", ".gitignore"])
})

test("usage errors exit 2 and print nothing on stdout", (t) => {
  const w = workspace()
  t.after(w.cleanup)
  for (const args of [[], ["--report", "r.md"], ["--wd", join(w.base, "nope")], ["--wd", w.wd, "--args-json", "{bad"],
    ["--wd", w.wd, "--args-json", "[1]"], ["--wd", w.wd, "--bogus"]]) {
    const r = finish(w.top, args)
    assert.equal(r.code, 2, JSON.stringify(args))
    assert.equal(r.out, null)
  }
  const r = spawnSync(process.execPath, [CLI, "start", "--wd", w.wd], { cwd: w.top, encoding: "utf8" })
  assert.equal(r.status, 2)
  assert.equal(existsSync(join(w.top, ".reviews")), false)
})
