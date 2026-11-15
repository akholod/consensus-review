// scripts/workspace-diff.mjs: one diff for a folder of repositories (workspace mode of
// /consensus-review §1). Expected values come from the request "a multi-repo folder is one feature:
// one report", and the §1 contract: paths prefixed by the repository directory, `changed` lists only
// repositories with changes, and a folder inside a repository is not a workspace.

import { after, test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SCRIPT = new URL("../../scripts/workspace-diff.mjs", import.meta.url).pathname

const dirs = []
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" })

/** A repository at `dir` with one committed file `name` holding `text`. */
function repo(dir, name = "a.txt", text = "one\n") {
  mkdirSync(dir, { recursive: true })
  git(dir, "init", "-q", "-b", "main")
  git(dir, "config", "user.email", "t@example.com")
  git(dir, "config", "user.name", "t")
  writeFileSync(join(dir, name), text)
  git(dir, "add", ".")
  git(dir, "commit", "-qm", "init")
}

function space() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workspace-")))
  dirs.push(root)
  mkdirSync(join(root, "wd"))
  mkdirSync(join(root, "ws"))
  return { wd: join(root, "wd"), ws: join(root, "ws") }
}

const run = (wd, ws) => spawnSync(process.execPath, [SCRIPT, "--wd", wd, "--root", ws], { encoding: "utf8" })

test("WS1: two changed repositories give one diff with repo-prefixed paths; a clean one is not changed", () => {
  const { wd, ws } = space()
  repo(join(ws, "api"))
  repo(join(ws, "group", "web"))
  repo(join(ws, "docs"))
  writeFileSync(join(ws, "api", "a.txt"), "two\n")
  writeFileSync(join(ws, "group", "web", "new.txt"), "x\n")

  const r = run(wd, ws)

  assert.equal(r.status, 0, r.stderr)
  const diff = readFileSync(join(wd, "diff.patch"), "utf8")
  assert.match(diff, /^diff --git a\/api\/a\.txt b\/api\/a\.txt$/m)
  assert.match(diff, /^\+two$/m)
  const ws_ = JSON.parse(readFileSync(join(wd, "workspace.json"), "utf8"))
  assert.deepEqual(ws_.changed, ["api", "group/web"])
  assert.deepEqual(ws_.repos.map((x) => [x.path, x.branch, x.files, x.untracked]), [
    ["api", "main", 1, []],
    ["docs", "main", 0, []],
    ["group/web", "main", 0, ["group/web/new.txt"]],
  ])
})

test("WS2: nothing changed exits 0 with an empty changed list and an empty diff", () => {
  const { wd, ws } = space()
  repo(join(ws, "api"))

  const r = run(wd, ws)

  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout).changed, [])
  assert.equal(readFileSync(join(wd, "diff.patch"), "utf8"), "")
})

test("WS3: a root inside a git repository is not a workspace", () => {
  const { wd, ws } = space()
  repo(ws)
  mkdirSync(join(ws, "sub"))

  const r = run(wd, join(ws, "sub"))

  assert.equal(r.status, 2)
  assert.match(r.stderr, /is inside a git repository/)
})

test("WS4: a folder with no repository stops", () => {
  const { wd, ws } = space()
  mkdirSync(join(ws, "plain"))

  const r = run(wd, ws)

  assert.equal(r.status, 2)
  assert.match(r.stderr, /no git repository under/)
})

test("WS5: a repository without commits is listed as skipped, the others still diff", () => {
  const { wd, ws } = space()
  repo(join(ws, "api"))
  mkdirSync(join(ws, "fresh"))
  git(join(ws, "fresh"), "init", "-q")
  writeFileSync(join(ws, "api", "a.txt"), "two\n")

  const r = run(wd, ws)

  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.repos.find((x) => x.path === "fresh").skipped, "no commits")
  assert.deepEqual(out.changed, ["api"])
})

test("WS6: tracked changes in a depth-2 repository carry the two-level prefix, after the depth-1 one", () => {
  const { wd, ws } = space()
  repo(join(ws, "api"))
  repo(join(ws, "group", "web"))
  writeFileSync(join(ws, "api", "a.txt"), "two\n")
  writeFileSync(join(ws, "group", "web", "a.txt"), "three\n")

  assert.equal(run(wd, ws).status, 0)

  const heads = readFileSync(join(wd, "diff.patch"), "utf8").match(/^diff --git .*$/gm)
  assert.deepEqual(heads, ["diff --git a/api/a.txt b/api/a.txt", "diff --git a/group/web/a.txt b/group/web/a.txt"])
})

test("WS7: node_modules, dot dirs, depth 3 and a repository nested in a repository are not searched", () => {
  const { wd, ws } = space()
  repo(join(ws, "api"))
  repo(join(ws, "api", "vendor", "inner"))
  repo(join(ws, "node_modules", "pkg"))
  repo(join(ws, ".cache", "x"))
  repo(join(ws, "a", "b", "deep"))

  const r = run(wd, ws)

  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout).repos.map((x) => x.path), ["api"])
})

test("WS8: a symlinked checkout is found under its link name", () => {
  const { wd, ws } = space()
  const real = join(ws, "..", "elsewhere")
  repo(real)
  symlinkSync(real, join(ws, "linked"))
  writeFileSync(join(real, "a.txt"), "two\n")

  const r = run(wd, ws)

  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout).changed, ["linked"])
})

test("WS9: an unreadable HEAD that is not unborn stops instead of being skipped as no commits", () => {
  const { wd, ws } = space()
  repo(join(ws, "api"))
  writeFileSync(join(ws, "api", ".git", "HEAD"), "0000000000000000000000000000000000000000\n")

  const r = run(wd, ws)

  assert.equal(r.status, 2)
  assert.match(r.stderr, /git failed in api/)
})

test("WS10: an untracked file reaches diff.patch as a new-file diff under its repository", () => {
  const { wd, ws } = space()
  repo(join(ws, "web"))
  writeFileSync(join(ws, "web", "feature.ts"), "export const f = 1\n")

  assert.equal(run(wd, ws).status, 0)

  const diff = readFileSync(join(wd, "diff.patch"), "utf8")
  assert.match(diff, /^diff --git a\/web\/feature\.ts b\/web\/feature\.ts$/m)
  assert.match(diff, /^\+export const f = 1$/m)
})

// feature-diff.mjs, the CLI over featureDiff: argument checks and the files it writes.
const FEATURE = new URL("../../scripts/feature-diff.mjs", import.meta.url).pathname
const feature = (args, env = {}) => spawnSync(process.execPath, [FEATURE, ...args], { encoding: "utf8", env: { ...process.env, ...env } })

test("FD1: one target is a usage error (feature mode needs two or more)", () => {
  const { wd, ws } = space()
  const r = feature(["--wd", wd, "--invoke", ws, "--target", "acme/api#7"])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /^usage: feature-diff\.mjs/)
})

test("FD2: a bare #N among several stops with exit 2 and the reason, writing nothing", () => {
  const { wd, ws } = space()
  const r = feature(["--wd", wd, "--invoke", ws, "--target", "#7", "--target", "acme/web#5"])
  assert.equal(r.status, 2)
  assert.equal(r.stderr, "#7: several PRs need owner/repo#N or a URL for each\n")
  assert.equal(existsSync(join(wd, "feature.json")), false)
})

test("FD3: two PRs through a fake gh write diff.patch and feature.json without the diff text", () => {
  const { wd, ws } = space()
  const bin = join(wd, "..", "bin")
  mkdirSync(bin)
  const diffs = { "acme/api#7": "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -1 +1 @@\n-a\n+b\n",
    "acme/web#5": "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-a\n+b\n" }
  writeFileSync(join(bin, "gh"), `#!${process.execPath}\nconst d = ${JSON.stringify(diffs)}; const a = process.argv.slice(2); const k = a[a.indexOf("-R") + 1] + "#" + a[2]; if (!d[k]) process.exit(1); process.stdout.write(d[k])\n`, { mode: 0o755 })
  symlinkSync(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), join(bin, "git"))

  const r = feature(["--wd", wd, "--invoke", ws, "--target", "acme/api#7", "--target", "acme/web#5"], { PATH: bin })

  assert.equal(r.status, 0, r.stderr)
  const saved = JSON.parse(readFileSync(join(wd, "feature.json"), "utf8"))
  assert.deepEqual(saved.prs.map((p) => [p.target, p.path, p.checkout, p.mode, p.files]), [
    ["acme/api#7", "@acme/api", false, "gh", 1],
    ["acme/web#5", "@acme/web", false, "gh", 1],
  ])
  assert.equal(saved.baseUsedFor, null)
  assert.equal("diffText" in saved.prs[0], false)
  assert.deepEqual(readFileSync(join(wd, "diff.patch"), "utf8").match(/^diff --git .*$/gm), [
    "diff --git a/@acme/api/a.go b/@acme/api/a.go",
    "diff --git a/@acme/web/b.ts b/@acme/web/b.ts",
  ])
})
