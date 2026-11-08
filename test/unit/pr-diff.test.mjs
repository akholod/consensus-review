// A PR without gh: resolveTarget's local-clone and curl paths and scripts/pr-diff.mjs. Expected
// values come from .omc/plans/issue-12-followups.md (#7, B1, the guardrails and the stage 2 rows):
// the diff is exactly `merge-base(base, head)..head` from the remote's advertised refs, or the run
// stops; the clone gains no ref, no FETCH_HEAD and no config.

import { after, test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveTarget } from "../../src/loop-review/context.mjs"
import { main } from "../../scripts/pr-diff.mjs"

const ORIGIN = "https://github.com/o/r.git"
const dirs = []
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" })
const commitFile = (repo, file, text) => {
  writeFileSync(join(repo, file), text)
  git(repo, "add", "-A")
  git(repo, "commit", "-qm", `${file}: ${text.trim()}`)
  return git(repo, "rev-parse", "HEAD").trim()
}

/** `gh` is absent; every other command runs for real. `calls` records each git subcommand. */
const noGh = (calls = []) => (cmd, args, options) => {
  if (cmd === "gh") return { error: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }), status: null }
  if (cmd === "git") calls.push(args[0])
  return spawnSync(cmd, args, options)
}

/**
 * A bare "remote" with main (c0 → P), release (c0 → R1) and refs/pull/1/head = P: a backport whose
 * head is already in main. The clone's origin is https://github.com/o/r.git, routed to the bare
 * repository by insteadOf, so identity must come from the raw URL.
 */
function fixture({ depth = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pr-diff-"))
  dirs.push(root)
  const seed = join(root, "seed")
  const bare = join(root, "remote.git")
  const clone = join(root, "clone")
  const wd = join(root, "wd")
  mkdirSync(seed)
  mkdirSync(wd)
  git(seed, "init", "-q", "-b", "main")
  git(seed, "config", "user.email", "t@t")
  git(seed, "config", "user.name", "t")
  git(seed, "config", "commit.gpgsign", "false")
  commitFile(seed, "f.txt", "1\n")
  git(seed, "branch", "release")
  const head = commitFile(seed, "f.txt", "2\n")
  git(seed, "checkout", "-q", "release")
  commitFile(seed, "r.txt", "release\n")
  git(root, "init", "-q", "--bare", "-b", "main", bare)
  git(seed, "push", "-q", bare, "main", "release", `${head}:refs/pull/1/head`)
  git(root, "clone", "-q", ...(depth ? ["--depth", String(depth)] : []), `file://${bare}`, clone)
  git(clone, "config", "remote.origin.url", ORIGIN)
  git(clone, "config", `url.file://${bare}.insteadOf`, ORIGIN)
  return { root, seed, bare, clone, wd, head }
}

const pr = (fx, prTarget, extra = {}) =>
  resolveTarget({ repo: fx.clone, mode: "pr", prTarget, workDir: fx.wd, run: noGh(), ...extra })

test("backport: base=release diffs release...pull/1/head from the remote, through the clone", () => {
  const fx = fixture()
  const expected = git(fx.bare, "diff", "-M", "release...refs/pull/1/head")

  const r = pr(fx, "https://github.com/o/r/pull/1", { base: "release" })

  assert.match(expected, /^\+2$/m)
  assert.equal(r.diffText, expected)
  assert.equal(r.mode, "clone")
  assert.equal(r.headSha, git(fx.bare, "rev-parse", "refs/pull/1/head").trim())
  assert.equal(r.baseRef, "release")
  assert.equal(r.base, git(fx.bare, "merge-base", "release", "refs/pull/1/head").trim())
})

test("#N uses origin, the same exact diff", () => {
  const fx = fixture()
  assert.equal(pr(fx, "#1", { base: "release" }).diffText, git(fx.bare, "diff", "-M", "release...refs/pull/1/head"))
})

test("without base= the clone path stops; pr-diff exits 2 and writes no diff.patch", () => {
  const fx = fixture()
  assert.throws(() => pr(fx, "#1"), { message: "PR mode without gh needs base=<branch> (the branch the PR targets)" })

  const errors = []
  const write = process.stderr.write
  process.stderr.write = (chunk) => errors.push(String(chunk))
  let code
  try {
    code = main(["--wd", fx.wd, "--repo", fx.clone, "--target", "#1"], { run: noGh() })
  } finally {
    process.stderr.write = write
  }
  assert.equal(code, 2)
  assert.equal(errors.join(""), "PR mode without gh needs base=<branch> (the branch the PR targets)\n")
  assert.deepEqual(readdirSync(fx.wd), [])
})

test("pr-diff writes the diff and prints headSha, baseRef and mode", () => {
  const fx = fixture()
  const out = []
  const write = process.stdout.write
  process.stdout.write = (chunk) => out.push(String(chunk))
  let code
  try {
    code = main(["--wd", fx.wd, "--repo", fx.clone, "--target", "#1", "--base", "release"], { run: noGh() })
  } finally {
    process.stdout.write = write
  }
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(out.join("")), { headSha: fx.head, baseRef: "release", mode: "clone" })
  assert.equal(readFileSync(join(fx.wd, "diff.patch"), "utf8"), git(fx.bare, "diff", "-M", "release...refs/pull/1/head"))
})

test("a depth-1 file:// clone stops as shallow before any ls-remote or fetch", () => {
  const fx = fixture({ depth: 1 })
  const calls = []
  assert.throws(() => pr(fx, "#1", { base: "release", run: noGh(calls) }), { message: "shallow clone; fetch full history or use gh" })
  assert.ok(!calls.includes("ls-remote") && !calls.includes("fetch"), calls.join(" "))
})

test("old head objects already local and a head that moves after the fetch → stop", () => {
  const fx = fixture()
  assert.equal(spawnSync("git", ["cat-file", "-e", fx.head], { cwd: fx.clone }).status, 0, "the clone already holds the head")
  let listed = 0
  const base = noGh()
  const run = (cmd, args, options) => {
    const result = base(cmd, args, options)
    if (cmd === "git" && args[0] === "ls-remote" && ++listed === 2) {
      return { ...result, stdout: result.stdout.replace(fx.head, "1".repeat(40)) }
    }
    return result
  }
  assert.throws(() => pr(fx, "#1", { base: "release", run }), { message: "PR ref moved during fetch; run it again" })
})

test("a stale local release branch does not change the operands", () => {
  const fx = fixture()
  git(fx.clone, "branch", "release", "origin/release")
  // The remote's release gains a commit on g.txt, and PR 2 builds on it and touches g.txt too.
  commitFile(fx.seed, "g.txt", "on release\n")
  git(fx.seed, "checkout", "-q", "-b", "pr2")
  const head2 = commitFile(fx.seed, "g.txt", "on the PR\n")
  git(fx.seed, "push", "-q", fx.bare, "release", `${head2}:refs/pull/2/head`)
  const mergeBase = git(fx.bare, "merge-base", "release", "refs/pull/2/head").trim()
  const expected = git(fx.bare, "diff", "-M", mergeBase, "refs/pull/2/head")

  const r = pr(fx, "#2", { base: "release" })

  assert.equal(r.diffText, expected)
  assert.doesNotMatch(r.diffText, /^\+on release$/m)
})

test("the fetch adds no ref, no config and leaves FETCH_HEAD byte-identical, even with a refs/pull/* fetch mapping", () => {
  const fx = fixture()
  git(fx.clone, "config", "--add", "remote.origin.fetch", "+refs/pull/*/head:refs/remotes/origin/pr/*")
  const fetchHead = join(fx.clone, ".git/FETCH_HEAD")
  writeFileSync(fetchHead, "0123456789abcdef0123456789abcdef01234567\t\tbranch 'x' of elsewhere\n")
  const before = {
    refs: git(fx.clone, "for-each-ref"),
    config: readFileSync(join(fx.clone, ".git/config")),
    fetchHead: readFileSync(fetchHead),
  }

  pr(fx, "#1", { base: "release" })

  assert.equal(git(fx.clone, "for-each-ref"), before.refs)
  assert.deepEqual(readFileSync(join(fx.clone, ".git/config")), before.config)
  assert.deepEqual(readFileSync(fetchHead), before.fetchHead)
})

test("a base ref missing on the remote stops", () => {
  const fx = fixture()
  assert.throws(() => pr(fx, "#1", { base: "nope" }), { message: "refs/heads/nope not found on remote origin" })
})

test("no matching remote: owner/repo#7 curls the diff on origin's host, diff-only", () => {
  const fx = fixture()
  git(fx.clone, "config", "remote.origin.url", "https://git.example.com/a/b")
  const urls = []
  const run = (cmd, args, options) => {
    if (cmd === "curl") {
      urls.push(args.at(-1))
      return { status: 0, stdout: "diff --git a/x b/x\n" }
    }
    return noGh()(cmd, args, options)
  }

  const r = pr(fx, "owner/repo#7", { run })

  assert.deepEqual(urls, ["https://git.example.com/owner/repo/pull/7.diff"])
  assert.equal(r.mode, "curl")
  assert.equal(r.base, null)
  assert.equal(r.describe, "PR owner/repo#7 (diff-only)")
})

test("no gh, no matching remote and no diff URL: #N without an origin stops naming gh", () => {
  const fx = fixture()
  git(fx.clone, "remote", "remove", "origin")
  assert.throws(() => pr(fx, "#1", { base: "release" }), /^Error: Command failed: gh pr diff #1: ENOENT; no local clone or public diff URL for it$/)
  assert.ok(!existsSync(join(fx.wd, "diff.patch")))
})

// Codex completion review, item 1: curl must not read ~/.curlrc, and an empty PR diff stops.
test("a ~/.curlrc with `output` does not divert the diff: curl runs with -q first and the patch comes back", () => {
  const fx = fixture()
  git(fx.clone, "config", "remote.origin.url", "https://git.example.com/a/b")
  const home = join(fx.root, "home")
  mkdirSync(home)
  const diverted = join(fx.root, "diverted.patch")
  writeFileSync(join(home, ".curlrc"), `output = "${diverted}"\n`)
  const patch = join(fx.root, "served.diff")
  writeFileSync(patch, "diff --git a/x b/x\n+served\n")
  // The real curl, HOME at the temp dir, the URL swapped for the local file; every flag kept.
  const run = (cmd, args, options) => {
    if (cmd !== "curl") return noGh()(cmd, args, options)
    const { XDG_CONFIG_HOME, CURL_HOME, ...env } = process.env
    return spawnSync("curl", [...args.slice(0, -1), `file://${patch}`], { ...options, env: { ...env, HOME: home } })
  }

  const r = pr(fx, "owner/repo#7", { run })

  assert.equal(r.diffText, "diff --git a/x b/x\n+served\n")
  assert.ok(!existsSync(diverted))
})

test("curl exiting 0 with an empty body stops; pr-diff exits 2 and writes no diff.patch", () => {
  const fx = fixture()
  git(fx.clone, "config", "remote.origin.url", "https://git.example.com/a/b")
  const run = (cmd, args, options) => (cmd === "curl" ? { status: 0, stdout: "" } : noGh()(cmd, args, options))
  assert.throws(() => pr(fx, "owner/repo#7", { run }), { message: "PR owner/repo#7: the curl diff is empty; nothing to review" })
  assert.equal(main(["--wd", fx.wd, "--target", "owner/repo#7", "--repo", fx.clone], { run }), 2)
  assert.ok(!existsSync(join(fx.wd, "diff.patch")))
})

test("gh printing an empty diff stops instead of becoming no changes", () => {
  const fx = fixture()
  const run = (cmd, args, options) => (cmd === "gh" ? { status: 0, stdout: "" } : spawnSync(cmd, args, options))
  assert.throws(() => pr(fx, "#1", { run }), { message: "PR #1: the gh diff is empty; nothing to review" })
})

// §1 now always diffs through pr-diff.mjs, so its gh try must reach owner/repo#N: gh accepts a
// number, URL or branch as the selector, and the repository only through -R.
test("gh gets owner/repo#7 as `7 -R owner/repo`, a URL and #N as given", () => {
  const fx = fixture()
  const calls = []
  const run = (cmd, args, options) => {
    if (cmd !== "gh") return spawnSync(cmd, args, options)
    calls.push(args)
    return { status: 0, stdout: "diff --git a/x b/x\n" }
  }

  pr(fx, "owner/repo#7", { run })
  pr(fx, "https://github.com/owner/repo/pull/7", { run })
  pr(fx, "#7", { run })

  assert.deepEqual(calls, [
    ["pr", "diff", "7", "-R", "owner/repo"],
    ["pr", "diff", "https://github.com/owner/repo/pull/7"],
    ["pr", "diff", "#7"],
  ])
})

test("a browser URL /pull/7/files?diff=split#r1 curls the canonical .diff URL", () => {
  const fx = fixture()
  git(fx.clone, "config", "remote.origin.url", "https://git.example.com/a/b")
  const urls = []
  const run = (cmd, args, options) => {
    if (cmd === "curl") {
      urls.push(args)
      return { status: 0, stdout: "diff --git a/x b/x\n" }
    }
    return noGh()(cmd, args, options)
  }

  pr(fx, "https://github.com/owner/repo/pull/7/files?diff=split#r1", { run })

  assert.deepEqual(urls, [["-q", "-fsSL", "https://github.com/owner/repo/pull/7.diff"]])
})
