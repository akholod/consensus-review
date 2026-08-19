// The doctor's whole value is that a broken environment produces a WARN or FAIL with a stated
// consequence. So the tests drive it against deliberately broken workspaces and assert it notices —
// a diagnostic that always says PASS is worse than none, because it manufactures confidence.
//
// Every test here runs `--offline`: the live probes cost real model calls and belong to a release
// gate, not to `node --test`.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { diagnose } from "../../scripts/doctor.mjs"

const ROOT = process.cwd()

/** Run the checks in-process against `repo`. Offline throughout: no model calls, no network. */
const doctor = (repo) => {
  const results = diagnose({ root: ROOT, repo, offline: true })
  return { ok: !results.some((r) => r.status === "fail"), results }
}

const find = (report, label) => report.results.find((r) => r.label === label)

/** A throwaway git repository, optionally seeded. */
function withRepo(fn, { commit = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "doctor-"))
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir })
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir })
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir })
    if (commit) {
      writeFileSync(join(dir, "a.txt"), "hello\n")
      execFileSync("git", ["add", "-A"], { cwd: dir })
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir })
    }
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("reports on this repository without failing", () => {
  const report = doctor(ROOT)
  assert.equal(report.ok, true, JSON.stringify(report.results.filter((r) => r.status === "fail"), null, 2))
  assert.equal(find(report, "agents and prompts").status, "ok")
  assert.equal(find(report, "generated blocks").status, "ok")
})

test("states which model each dimension runs on", () => {
  const detail = find(doctor(ROOT), "dimension models").detail
  // The split is the kind of thing a user cannot otherwise see without opening five files.
  assert.match(detail, /arch=\w+/)
  assert.match(detail, /quality=\w+/)
  assert.match(detail, /verifier=\w+/)
})

test("every non-ok result explains what it does to a review", () => {
  // A status without a consequence is just noise; this is the property that makes the tool useful.
  for (const r of doctor(ROOT).results) {
    if (r.status === "warn" || r.status === "fail") {
      assert.ok(r.consequence, `${r.label} is ${r.status} but states no consequence`)
    }
  }
})

test("--offline marks every networked check skipped rather than passing it", () => {
  const report = doctor(ROOT)
  // The release lookup reaches GitHub, so it is skipped too — otherwise `--offline` would still
  // make a network call, and `node --test` would depend on GitHub being reachable.
  for (const label of ["version", "claude envelope", "codex schema"]) {
    const r = find(report, label)
    assert.equal(r.status, "skip", `${label} must not report a verdict it did not earn`)
    assert.ok(r.consequence, `${label} must say what skipping it costs`)
  }
})

test("a directory that is not a git work tree fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-plain-"))
  try {
    const report = doctor(dir)
    assert.equal(report.ok, false)
    const r = find(report, "git repository")
    assert.equal(r.status, "fail")
    assert.match(r.consequence, /no diff to review/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a repository with no commits fails", () => {
  withRepo((dir) => {
    const report = doctor(dir)
    assert.equal(report.ok, false)
    assert.equal(find(report, "commits").status, "fail")
  }, { commit: false })
})

test("an unignored .reviews/ is flagged, because the next review would pick it up", () => {
  withRepo((dir) => {
    mkdirSync(join(dir, ".reviews"))
    const r = find(doctor(dir), ".reviews in git")
    assert.equal(r.status, "warn")
    assert.match(r.consequence, /untracked changes by the NEXT review/)
  })
})

test("an ignored .reviews/ is not flagged", () => {
  withRepo((dir) => {
    writeFileSync(join(dir, ".gitignore"), ".reviews/\n")
    execFileSync("git", ["add", "-A"], { cwd: dir })
    execFileSync("git", ["commit", "-q", "-m", "ignore"], { cwd: dir })
    mkdirSync(join(dir, ".reviews"))
    assert.equal(find(doctor(dir), ".reviews in git"), undefined)
    assert.match(find(doctor(dir), "report output").detail, /gitignored/)
  })
})

test("no code graph is a warning, not a failure — grep is a supported fallback", () => {
  withRepo((dir) => {
    const r = find(doctor(dir), "graph in repo")
    assert.equal(r.status, "warn")
    assert.match(r.consequence, /fall back to grep/)
  })
})

test("a graph older than the last commit is reported stale", () => {
  withRepo((dir) => {
    mkdirSync(join(dir, ".codegraph"))
    const db = join(dir, ".codegraph/codegraph.db")
    writeFileSync(db, "")
    // Build the graph, then commit after it — the ordinary way a graph goes stale.
    const old = Date.now() / 1000 - 5 * 86400
    utimesSync(db, old, old)
    const r = find(doctor(dir), "graph freshness")
    assert.equal(r.status, "warn")
    assert.match(r.detail, /codegraph graph is \d+ day\(s\) older/)
    assert.match(r.consequence, /point reviewers at code that moved/)
  })
})

test("a graph newer than the last commit is current", () => {
  withRepo((dir) => {
    mkdirSync(join(dir, "graphify-out"))
    writeFileSync(join(dir, "graphify-out/graph.json"), "{}")
    const r = find(doctor(dir), "graph freshness")
    assert.equal(r.status, "ok")
    assert.match(r.detail, /graphify/)
  })
})

test("exit code is 1 on a failure and 0 otherwise", () => {
  const run = (repo) => {
    try {
      execFileSync("node", [join(ROOT, "scripts/doctor.mjs"), "--offline", "--json", "--repo", repo], { encoding: "utf8" })
      return 0
    } catch (err) {
      return err.status
    }
  }
  assert.equal(run(ROOT), 0)
  const dir = mkdtempSync(join(tmpdir(), "doctor-exit-"))
  try {
    assert.equal(run(dir), 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a warning alone never fails the command", () => {
  withRepo((dir) => {
    const report = doctor(dir)
    assert.ok(report.results.some((r) => r.status === "warn"), "expected at least one warning in a bare repo")
    assert.equal(report.ok, true, "warnings must not fail the run")
  })
})

test("optional tooling being absent must not fail the run", () => {
  // CI caught this the hard way: `codex` is not installed on the runner, it was marked `fail`, and
  // every doctor run failed. The severity rule is that only "cannot run, or is broken while you
  // believe it works" is a failure — a consultant you never installed is a choice, and the floor
  // case explicitly builds the report without it rather than aborting.
  //
  // Spawned with a stripped PATH rather than driven in-process, because the tool lookups are
  // memoised per process and a real absent-tool environment is the thing under test.
  const dir = mkdtempSync(join(tmpdir(), "doctor-nopath-"))
  try {
    for (const t of ["node", "git"]) {
      const real = execFileSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).trim()
      execFileSync("ln", ["-s", real, join(dir, t)])
    }
    const out = execFileSync("node", [join(ROOT, "scripts/doctor.mjs"), "--offline", "--json"], {
      encoding: "utf8",
      env: { ...process.env, PATH: dir },
    })
    const report = JSON.parse(out)
    assert.equal(report.ok, true, "a machine without codex/pi/gh/codegraph must still pass")
    assert.equal(report.results.find((r) => r.label === "codex").status, "warn")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
