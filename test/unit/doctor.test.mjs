// The doctor's whole value is that a broken environment produces a WARN or FAIL with a stated
// consequence. So the tests drive it against deliberately broken workspaces and assert it notices —
// a diagnostic that always says PASS is worse than none, because it manufactures confidence.
//
// Every test here runs `--offline`: the live probes cost real model calls and belong to a release
// gate, not to `node --test`. The claude-cli probe is driven directly against a fake `claude`.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { diagnose } from "../../scripts/doctor.mjs"
import { probeClaudeCli } from "../../scripts/lib/probe.mjs"

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

test("E7: the dimension models line pins the frontmatter models and efforts", () => {
  // Expected from step 7 of .omc/plans/issue-7-profiles.md (the new frontmatter defaults).
  assert.equal(find(doctor(ROOT), "dimension models").detail,
    "arch=opus/medium impact=opus/high quality=sonnet/high test=sonnet/high verifier=opus/high")
})

/** doctor --offline --json in a child, with PATH holding node, git and a `claude` printing `version`. */
function doctorWithClaudeVersion(version, args = []) {
  const bin = mkdtempSync(join(tmpdir(), "doctor-claude-version-"))
  try {
    for (const t of ["node", "git"]) {
      const real = execFileSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).trim()
      execFileSync("ln", ["-s", real, join(bin, t)])
    }
    writeFileSync(join(bin, "claude"), `#!/bin/sh\necho '${version}'\n`)
    chmodSync(join(bin, "claude"), 0o755)
    const out = execFileSync("node", [join(ROOT, "scripts/doctor.mjs"), "--offline", "--json", ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: bin },
    })
    return JSON.parse(out).results
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
}

test("a claude CLI older than 2.1.292 gets one effort warn row", () => {
  const rows = doctorWithClaudeVersion("2.1.200 (Claude Code)").filter((r) => r.label === "claude effort")
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, "warn")
  assert.equal(rows[0].detail, "claude 2.1.200: effort= on subagents needs 2.1.292+")
})

for (const version of ["2.1.319 (Claude Code)", "2.1.292 (Claude Code)"]) {
  test(`a claude CLI at ${version} gets no effort row`, () => {
    assert.equal(doctorWithClaudeVersion(version).some((r) => r.label === "claude effort"), false)
  })
}

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

test("names the consultant a review would run, and why, with the presence-only caveat", () => {
  const r = doctor(ROOT).results.find((x) => x.label.startsWith("consultant: "))
  assert.ok(r, "no consultant line")
  assert.match(r.label, /^consultant: (codex|pi|claude-cli)$/)
  assert.ok(r.detail, "the selection reason is missing")
  assert.match(r.consequence, /presence only/)
})

test("--consultant mirrors a forced consultant: forced claude-cli is named and reported as forced", () => {
  // A fake `claude` on PATH: the read-only line needs claude-cli to be present, and CI has no claude.
  const results = doctorWithClaudeVersion("2.1.319 (Claude Code)", ["--consultant", "claude-cli"])
  const line = results.find((x) => x.label.startsWith("consultant: "))
  assert.equal(line.label, "consultant: claude-cli")
  assert.match(line.detail, /forced/)
  assert.ok(results.some((x) => x.label === "claude-cli read-only"), "a forced claude-cli gets its read-only line")
})

/** A fake `claude` that emits a stream-json init and result line; FAKE_CLAUDE picks a defect. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs")
const { execSync } = require("node:child_process")
const mode = process.env.FAKE_CLAUDE ?? "ok"
const tools = ["Glob", "Grep", "Read", "StructuredOutput", ...(mode === "bash" ? ["Bash"] : [])]
const mcp_servers = mode === "mcp" ? [{ name: "fs", status: "connected" }] : []
if (mode === "hook") execSync(JSON.parse(readFileSync(".claude/settings.json", "utf8")).hooks.SessionStart[0].hooks[0].command)
if (mode === "write") writeFileSync("NOTES.md", "x")
console.log(JSON.stringify({ type: "system", subtype: "init", tools, mcp_servers, model: "claude-sonnet-5-5" }))
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, stop_reason: "tool_use", structured_output: { findings: [] } }))
`

/** Put a fake `claude` first on PATH (as a .cjs-free script: no package.json above the temp dir). */
function withFakeClaude(fn) {
  const bin = mkdtempSync(join(tmpdir(), "doctor-fake-claude-"))
  const path = process.env.PATH
  try {
    writeFileSync(join(bin, "claude"), FAKE_CLAUDE)
    chmodSync(join(bin, "claude"), 0o755)
    process.env.PATH = `${bin}:${path}`
    return fn(bin)
  } finally {
    process.env.PATH = path
    delete process.env.FAKE_CLAUDE
    rmSync(bin, { recursive: true, force: true })
  }
}

const probeWith = (mode) => {
  process.env.FAKE_CLAUDE = mode
  const probe = probeClaudeCli({ root: ROOT, timeoutMs: 20_000 })
  return { ...probe, failed: probe.checks.filter(([, pass]) => !pass).map(([label]) => label) }
}

test("claude-cli probe passes on a read-only lane", () => {
  withFakeClaude(() => {
    const probe = probeWith("ok")
    assert.equal(probe.ok, true, probe.detail)
    assert.deepEqual(probe.failed, [])
  })
})

for (const [mode, check] of [
  ["bash", /^init tools within/],
  ["mcp", /^no MCP servers$/],
  ["hook", /^repo SessionStart hook did not fire$/],
  ["write", /^repo snapshot unchanged$/],
]) {
  test(`claude-cli probe fails, distinctly, on a lane defect: ${mode}`, () => {
    withFakeClaude(() => {
      const probe = probeWith(mode)
      assert.equal(probe.ok, false)
      assert.equal(probe.failed.length, 1, probe.detail)
      assert.match(probe.failed[0], check)
    })
  })
}

test("with only claude installed, doctor selects claude-cli and --offline skips its probe", () => {
  withFakeClaude((bin) => {
    for (const t of ["node", "git"]) {
      const real = execFileSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).trim()
      execFileSync("ln", ["-s", real, join(bin, t)])
    }
    const out = execFileSync("node", [join(ROOT, "scripts/doctor.mjs"), "--offline", "--json"], {
      encoding: "utf8",
      env: { ...process.env, PATH: bin },
    })
    const results = JSON.parse(out).results
    assert.ok(results.some((r) => r.label === "consultant: claude-cli"), "claude-cli not selected")
    assert.equal(results.find((r) => r.label === "claude-cli read-only").status, "skip")
  })
})

// ── T9 lenses ────────────────────────────────────────────────────────────────────────────────
const LENS_CONSEQUENCE = {
  glob: "this glob matches no tracked file; the lens fires only for new files it matches",
  rejected: "this lens is never applied",
  key: "this key has no effect in this version",
  none: "reviews apply only the generic dimensions",
}

const lensRows = (report) => report.results.filter((r) => r.section === "lenses")

/** A lens file with the given name and front matter lines. */
function addLens(dir, name, frontMatter) {
  mkdirSync(join(dir, ".consensus-review/lenses"), { recursive: true })
  writeFileSync(join(dir, ".consensus-review/lenses", `${name}.md`), `---\n${frontMatter}\n---\nCheck it.\n`)
}

test("T9.1 no lenses: lenses is skipped with the generic-dimensions consequence", () => {
  withRepo((dir) => {
    const rows = lensRows(doctor(dir))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].status, "skip")
    assert.equal(rows[0].consequence, LENS_CONSEQUENCE.none)
  })
})

test("T9.2 a lens whose glob matches a tracked file is ok", () => {
  withRepo((dir) => {
    mkdirSync(join(dir, "src/payments"), { recursive: true })
    writeFileSync(join(dir, "src/payments/a.js"), "x\n")
    addLens(dir, "payments", "paths: [src/payments/**]")
    execFileSync("git", ["add", "-A"], { cwd: dir })
    const rows = lensRows(doctor(dir))
    assert.deepEqual(rows.map((r) => [r.status, r.detail]), [["ok", "lens all, 1 globs"]])
  })
})

test("T9.3 a glob matching no tracked file warns", () => {
  withRepo((dir) => {
    addLens(dir, "billing", "paths: [src/billing/**]")
    const warn = lensRows(doctor(dir)).find((r) => r.status === "warn")
    assert.equal(warn.detail, "glob matches no tracked file: src/billing/**")
    assert.equal(warn.consequence, LENS_CONSEQUENCE.glob)
  })
})

test("T9.4 a rejected file warns with its reason", () => {
  withRepo((dir) => {
    addLens(dir, "Bad Name", "paths: [a.txt]")
    const rows = lensRows(doctor(dir))
    assert.deepEqual(rows.map((r) => [r.status, r.label, r.detail, r.consequence]),
      [["warn", ".consensus-review/lenses/Bad Name.md", "invalid name", LENS_CONSEQUENCE.rejected]])
  })
})

test("T9.5 an ignored front matter key warns", () => {
  withRepo((dir) => {
    addLens(dir, "sev", "paths: [a.txt]\nseverity: P1")
    const warn = lensRows(doctor(dir)).find((r) => r.status === "warn")
    assert.equal(warn.detail, "ignored key: severity")
    assert.equal(warn.consequence, LENS_CONSEQUENCE.key)
  })
})

test("T9.7 only lens warnings: the command still exits 0", () => {
  withRepo((dir) => {
    addLens(dir, "Bad Name", "paths: [a.txt]")
    const out = execFileSync("node", [join(ROOT, "scripts/doctor.mjs"), "--offline", "--json", "--repo", dir], { encoding: "utf8" })
    assert.equal(JSON.parse(out).ok, true)
  })
})

// ── profiles (plan issue-7-profiles, Doctor) ─────────────────────────────────────────────────
const profileRows = (report) => report.results.filter((r) => r.section === "profiles")

function addProfile(dir, name, text) {
  mkdirSync(join(dir, ".consensus-review/profiles"), { recursive: true })
  writeFileSync(join(dir, ".consensus-review/profiles", `${name}.md`), text)
  execFileSync("git", ["add", "-A"], { cwd: dir })
  execFileSync("git", ["commit", "-q", "-m", name], { cwd: dir })
}

test("profiles: a committed profile is ok with its keys in SETTINGS order", () => {
  withRepo((dir) => {
    addProfile(dir, "ci", "---\ndepth: minimal\nsceptic: basic\ndims: impact,tests\nout: none\n---\n")
    assert.deepEqual(profileRows(doctor(dir)).map((r) => [r.status, r.label, r.detail]),
      [["ok", "profile ci", "4 keys: depth, dims, sceptic, out"]])
  })
})

test("profiles: a bad value warns that it stops any run naming it", () => {
  withRepo((dir) => {
    addProfile(dir, "bad", "---\nsceptic: strct\n---\n")
    assert.deepEqual(profileRows(doctor(dir)).map((r) => [r.status, r.detail, r.consequence]),
      [["warn", "profile bad: sceptic=strct: expected off|basic|strict", "this profile stops any run that names it"]])
  })
})

test("profiles: an uncommitted profile warns", () => {
  withRepo((dir) => {
    mkdirSync(join(dir, ".consensus-review/profiles"), { recursive: true })
    writeFileSync(join(dir, ".consensus-review/profiles/ci.md"), "---\ndepth: minimal\n---\n")
    assert.deepEqual(profileRows(doctor(dir)).map((r) => [r.status, r.detail]), [["warn", "profile ci: not committed"]])
  })
})

test("profiles: no profiles directory is skip, none found", () => {
  withRepo((dir) => {
    assert.deepEqual(profileRows(doctor(dir)).map((r) => [r.status, r.detail]), [["skip", "none found"]])
  })
})
