// scripts/lib/feature.mjs: prefixDiff (header paths only) and featureDiff (several PRs as one
// feature). Expected values come from the request "several PRs of different repositories are one
// feature, not the last one wins" and the git diff header format (diff --git / --- / +++ / rename).

import { after, test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { featureDiff, prefixDiff, workspaceDiff } from "../../scripts/lib/feature.mjs"

const dirs = []
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

const DIFF = [
  "diff --git a/src/x.js b/src/x.js",
  "index 1..2 100644",
  "--- a/src/x.js",
  "+++ b/src/x.js",
  "@@ -1 +1 @@",
  "--- a/not-a-header",
  "+++ b/not-a-header",
  "diff --git a/old.js b/new.js",
  "similarity index 90%",
  "rename from old.js",
  "rename to new.js",
  "diff --git a/n.txt b/n.txt",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/n.txt",
  "@@ -0,0 +1 @@",
  "+x",
  "",
].join("\n")

test("F1: prefixDiff prefixes every header path, keeps /dev/null and never touches hunk lines", () => {
  assert.equal(prefixDiff(DIFF, "api"), [
    "diff --git a/api/src/x.js b/api/src/x.js",
    "index 1..2 100644",
    "--- a/api/src/x.js",
    "+++ b/api/src/x.js",
    "@@ -1 +1 @@",
    "--- a/not-a-header",
    "+++ b/not-a-header",
    "diff --git a/api/old.js b/api/new.js",
    "similarity index 90%",
    "rename from api/old.js",
    "rename to api/new.js",
    "diff --git a/api/n.txt b/api/n.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/api/n.txt",
    "@@ -0,0 +1 @@",
    "+x",
    "",
  ].join("\n"))
})

test("F2: a path containing ' b/' and a quoted path keep their sides", () => {
  assert.equal(prefixDiff("diff --git a/x b/y.js b/x b/y.js\n", "w"), "diff --git a/w/x b/y.js b/w/x b/y.js\n")
  assert.equal(prefixDiff('diff --git "a/t\\tx" "b/t\\tx"\n', "w"), 'diff --git "a/w/t\\tx" "b/w/t\\tx"\n')
})

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" })

function checkout(dir, remote) {
  mkdirSync(dir, { recursive: true })
  git(dir, "init", "-q")
  git(dir, "remote", "add", "origin", remote)
}

/** `owner/repo#N` of a gh call: a PR URL, or N with `-R owner/repo`. */
const ghKey = (args) => {
  const url = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(args[2])
  if (url) return `${url[1]}#${url[2]}`
  const r = args.indexOf("-R")
  return r > 0 ? `${args[r + 1]}#${args[2]}` : null
}

/** Records every call; git passes through; `gh pr diff` answers from `diffs` by `owner/repo#N`, curl by URL. */
const fakeRun = (diffs, curls = {}) => {
  const calls = []
  const run = (cmd, args, options) => {
    calls.push([cmd, ...args])
    if (cmd === "gh") {
      const out = diffs[ghKey(args)]
      return out === undefined ? { status: 1, stdout: "", stderr: "not found" } : { status: 0, stdout: out, stderr: "" }
    }
    if (cmd === "curl") {
      const out = curls[args.at(-1)]
      return out === undefined ? { status: 22, stdout: "", stderr: "404" } : { status: 0, stdout: out, stderr: "" }
    }
    return spawnSync(cmd, args, options)
  }
  return { run, calls }
}

const one = (path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`

function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "feature-")))
  dirs.push(root)
  mkdirSync(join(root, "ws"))
  mkdirSync(join(root, "wd"))
  return { ws: join(root, "ws"), wd: join(root, "wd") }
}

test("F3: two PRs map to their checkouts by remote and give one diff, in the order given; repos are told apart", () => {
  const { ws, wd } = workspace()
  checkout(join(ws, "backend"), "git@github.com:acme/api.git")
  checkout(join(ws, "frontend"), "https://github.com/acme/web")
  const web = "https://github.com/acme/web/pull/5"
  // Same number in both repositories: a fake keyed by the number alone would mix them up.
  const { run } = fakeRun({ "acme/web#5": one("src/app.ts"), "acme/api#5": one("src/route.ts") })

  const r = featureDiff({ invoke: ws, targets: [web, "acme/api#5"], workDir: wd, run })

  assert.equal(r.root, ws)
  assert.deepEqual(r.prs.map((p) => [p.target, p.path, p.checkout, p.files]), [
    [web, "frontend", true, 1],
    ["acme/api#5", "backend", true, 1],
  ])
  assert.deepEqual(r.diffText.match(/^diff --git .*$/gm), [
    "diff --git a/frontend/src/app.ts b/frontend/src/app.ts",
    "diff --git a/backend/src/route.ts b/backend/src/route.ts",
  ])
})

test("F4: a PR with no checkout is prefixed @owner/repo, a name no local folder has", () => {
  const { ws, wd } = workspace()
  checkout(join(ws, "backend"), "git@github.com:acme/api.git")
  mkdirSync(join(ws, "docs")) // an unrelated folder named like the repository
  const { run } = fakeRun({ "acme/api#7": one("a.go"), "acme/docs#2": one("b.md") })

  const r = featureDiff({ invoke: ws, targets: ["acme/api#7", "https://github.com/acme/docs/pull/2"], workDir: wd, run })

  assert.deepEqual(r.prs.map((p) => [p.path, p.checkout]), [["backend", true], ["@acme/docs", false]])
  assert.match(r.diffText, /^diff --git a\/@acme\/docs\/b\.md b\/@acme\/docs\/b\.md$/m)
})

test("F5: invoked inside one checkout, the root is its parent so sibling checkouts match", () => {
  const { ws, wd } = workspace()
  checkout(join(ws, "api"), "git@github.com:acme/api.git")
  checkout(join(ws, "web"), "git@github.com:acme/web.git")
  const { run } = fakeRun({ "acme/api#7": one("a.go"), "acme/web#5": one("b.ts") })

  const r = featureDiff({ invoke: join(ws, "api"), targets: ["acme/api#7", "acme/web#5"], workDir: wd, run })

  assert.equal(r.root, ws)
  assert.deepEqual(r.prs.map((p) => p.path), ["api", "web"])
})

for (const [targets, error] of [
  [["#7", "acme/web#5"], "#7: several PRs need owner/repo#N or a URL for each"],
  [["acme/api#7", "https://github.com/acme/api/pull/8"], "acme/api#7 and https://github.com/acme/api/pull/8: two PRs of one repository (acme/api); review them one at a time"],
]) {
  test(`F6: ${targets.join(" ")} stops: ${error}`, () => {
    const { ws, wd } = workspace()
    assert.throws(() => featureDiff({ invoke: ws, targets, workDir: wd, run: fakeRun({}).run }), { message: error })
  })
}

test("F6b: two repositories with one name and no checkout are two PRs, not one repository", () => {
  const { ws, wd } = workspace()
  const { run } = fakeRun({ "acme/api#1": one("a"), "other/api#2": one("b") })

  const r = featureDiff({ invoke: ws, targets: ["https://github.com/acme/api/pull/1", "https://github.com/other/api/pull/2"], workDir: wd, run })

  assert.deepEqual(r.prs.map((p) => p.path), ["@acme/api", "@other/api"])
})

test("F8: without gh and with one base for two checkouts, no clone path runs: both diffs come over HTTP", () => {
  const { ws, wd } = workspace()
  checkout(join(ws, "api"), "git@github.com:acme/api.git")
  checkout(join(ws, "web"), "git@github.com:acme/web.git")
  const { run, calls } = fakeRun({}, {
    "https://github.com/acme/api/pull/7.diff": one("a.go"),
    "https://github.com/acme/web/pull/5.diff": one("b.ts"),
  })

  const r = featureDiff({ invoke: ws, targets: ["acme/api#7", "acme/web#5"], workDir: wd, base: "main", run })

  assert.deepEqual(r.prs.map((p) => p.mode), ["curl", "curl"])
  assert.equal(r.baseUsedFor, null)
  assert.equal(calls.filter((c) => c[0] === "git" && ["fetch", "ls-remote"].includes(c[1])).length, 0)
})

test("F9: with one checkout, base reaches that PR's clone path only", () => {
  const { ws, wd } = workspace()
  checkout(join(ws, "api"), "git@github.com:acme/api.git")
  const { run, calls } = fakeRun({}, { "https://github.com/acme/web/pull/5.diff": one("b.ts") })

  // The clone path fails here (the remote is not reachable): what matters is that it was tried for api.
  assert.throws(() => featureDiff({ invoke: ws, targets: ["https://github.com/acme/web/pull/5", "acme/api#7"], workDir: wd, base: "main", run }))
  assert.ok(calls.some((c) => c[0] === "git" && c[1] === "rev-parse" && c[2] === "--is-shallow-repository"), "api took the clone path")
})

test("F7: workspaceDiff includes an untracked file as a prefixed new-file diff, and lists it", () => {
  const { ws } = workspace()
  const dir = join(ws, "api")
  mkdirSync(dir)
  git(dir, "init", "-q")
  git(dir, "-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init")
  execFileSync("sh", ["-c", "echo new > fresh.txt"], { cwd: dir })

  const r = workspaceDiff(ws)

  assert.match(r.diffText, /^diff --git a\/api\/fresh\.txt b\/api\/fresh\.txt$/m)
  assert.match(r.diffText, /^\+new$/m)
  assert.deepEqual(r.repos[0].untracked, ["api/fresh.txt"])
})

test("F10: prefixDiff handles copy, quoted rename, an escaped quote and a binary name with ' and '", () => {
  const input = [
    "diff --git a/x.js b/y.js",
    "copy from x.js",
    "copy to y.js",
    'diff --git "a/q\\"x" "b/q\\"y"',
    'rename from "q\\"x"',
    'rename to "q\\"y"',
    "diff --git a/cat and dog.png b/cat and dog.png",
    "Binary files a/cat and dog.png and b/cat and dog.png differ",
    "diff --git a/n.bin b/n.bin",
    "new file mode 100644",
    "Binary files /dev/null and b/n.bin differ",
    "",
  ].join("\n")
  assert.equal(prefixDiff(input, "p"), [
    "diff --git a/p/x.js b/p/y.js",
    "copy from p/x.js",
    "copy to p/y.js",
    'diff --git "a/p/q\\"x" "b/p/q\\"y"',
    'rename from "p/q\\"x"',
    'rename to "p/q\\"y"',
    "diff --git a/p/cat and dog.png b/p/cat and dog.png",
    "Binary files a/p/cat and dog.png and b/p/cat and dog.png differ",
    "diff --git a/p/n.bin b/p/n.bin",
    "new file mode 100644",
    "Binary files /dev/null and b/p/n.bin differ",
    "",
  ].join("\n"))
})
