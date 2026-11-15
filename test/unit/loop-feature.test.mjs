// /loop-review over a feature spread across repositories: bin/loop-review.mjs run from a folder of
// repositories (workspace mode) and with several --pr (feature mode), against a fake `claude` that
// logs what each call saw and a fake `gh`. Expected values come from the request "a multi-repo
// folder / several PRs are one feature: one review, one report", with repository-prefixed paths.

import { after, test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "xdg-"))
after(() => rmSync(process.env.XDG_CONFIG_HOME, { recursive: true, force: true }))

const BIN = new URL("../../bin/loop-review.mjs", import.meta.url).pathname
const GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim()
const temps = []
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }) })

// Every pass reports nothing; the log keeps each call's prompt and system prefix.
const CLAUDE = `const fs = require("fs")
const a = process.argv.slice(2)
const at = (f) => { const i = a.indexOf(f); return i < 0 ? null : a[i + 1] }
const verify = JSON.parse(at("--json-schema")).required.includes("verdicts")
const file = at("--append-system-prompt-file")
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ prompt: at("-p"), prefix: file ? fs.readFileSync(file, "utf8") : "" }) + "\\n")
const out = verify ? { verdicts: [], cell_verdicts: [] } : { findings: [], cells: [] }
process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "{}", structured_output: out, usage: {} }))
`

function setup() {
  const root = mkdtempSync(join(tmpdir(), "loop-feature-"))
  temps.push(root)
  const ws = join(root, "ws")
  const bin = join(root, "bin")
  mkdirSync(ws)
  mkdirSync(bin)
  const repo = (name, remote, file, text) => {
    const dir = join(ws, name)
    mkdirSync(join(dir, "src"), { recursive: true })
    const git = (...args) => execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" })
    git("init", "-q")
    git("remote", "add", "origin", remote)
    writeFileSync(join(dir, file), text)
    git("add", "-A")
    git("commit", "-qm", "init")
    return dir
  }
  symlinkSync(GIT, join(bin, "git"))
  writeFileSync(join(bin, "claude"), `#!${process.execPath}\n${CLAUDE}`)
  chmodSync(join(bin, "claude"), 0o755)
  const log = join(root, "calls.jsonl")
  const review = (cwdRepo, ...args) => {
    const r = spawnSync(process.execPath, [BIN, "--repo", cwdRepo, "--no-archive", "--out", join(root, "report.md"), "--max-calls", "4", ...args],
      { encoding: "utf8", env: { ...process.env, PATH: bin, CALL_LOG: log } })
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []
    const report = existsSync(join(root, "report.md")) ? readFileSync(join(root, "report.md"), "utf8") : ""
    return { r, calls, report }
  }
  /** A fake gh printing the diff named by the PR number in its argv. */
  const fakeGh = (diffs) => {
    writeFileSync(join(root, "gh.json"), JSON.stringify(diffs))
    // Keyed by owner/repo#N, from a PR URL or from N with -R: two repositories with one number stay apart.
    const body = `const d = require(${JSON.stringify(join(root, "gh.json"))}); const a = process.argv.slice(2)
const u = /github\\.com\\/([^/]+\\/[^/]+)\\/pull\\/(\\d+)/.exec(a[2]); const r = a.indexOf("-R")
const k = u ? u[1] + "#" + u[2] : r > 0 ? a[r + 1] + "#" + a[2] : null
if (!d[k]) process.exit(1); process.stdout.write(d[k])\n`
    writeFileSync(join(bin, "gh"), `#!${process.execPath}\n${body}`, { mode: 0o755 })
  }
  return { ws, repo, review, fakeGh }
}

const one = (path, from, to) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${from}\n+${to}\n`

test("LF1: a folder of repositories is reviewed as one workspace diff with prefixed paths", () => {
  const env = setup()
  const api = env.repo("api", "https://github.com/acme/api.git", "src/a.js", "export const a = 1\n")
  const web = env.repo("web", "https://github.com/acme/web.git", "src/b.js", "export const b = 1\n")
  writeFileSync(join(api, "src/a.js"), "export const a = 2\n")
  writeFileSync(join(web, "src/new.js"), "export const n = 1\n")

  const status = (dir) => execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" })
  const before = [status(api), status(web), readFileSync(join(api, ".git", "index")), readFileSync(join(web, ".git", "index"))]

  const { r, calls, report } = env.review(env.ws)

  assert.ok(report, r.stderr)
  assert.ok(calls.length >= 1, r.stderr)
  // Read-only at run time: neither reviewed repository's status nor index moved.
  assert.deepEqual([status(api), status(web), readFileSync(join(api, ".git", "index")), readFileSync(join(web, ".git", "index"))], before)
  assert.ok(calls[0].prefix.includes("api/src/a.js") && calls[0].prefix.includes("web/src/new.js"), "both repositories in one context")
  assert.match(report, /workspace .*\(api, web\)/)
  assert.match(report, /repo lenses: not applied \(workspace: no single repository\)/)
})

test("LF2: two --pr of two repositories are one feature, each under its checkout's directory", () => {
  const env = setup()
  env.repo("backend", "https://github.com/acme/api.git", "src/a.js", "x\n")
  env.repo("frontend", "https://github.com/acme/web.git", "src/b.js", "x\n")
  env.fakeGh({ "acme/api#5": one("src/a.js", "x", "y"), "acme/web#5": one("src/b.js", "x", "z") })

  const { r, calls, report } = env.review(env.ws, "--pr", "acme/api#5", "--pr=acme/web#5")

  assert.ok(report, r.stderr)
  assert.doesNotMatch(r.stderr, /diff changed during the run/, "the re-sampled feature diff is the same diff")
  assert.ok(calls[0].prefix.includes("backend/src/a.js") && calls[0].prefix.includes("frontend/src/b.js"), r.stderr)
  assert.match(report, /feature: acme\/api#5 → backend, acme\/web#5 → frontend/)
})

test("LF3: two PRs of one repository stop with exit 2 and the reason", () => {
  const env = setup()
  env.repo("backend", "https://github.com/acme/api.git", "src/a.js", "x\n")
  env.fakeGh({ "acme/api#7": one("src/a.js", "x", "y"), "acme/api#8": one("src/a.js", "x", "z") })

  const { r, calls } = env.review(env.ws, "--pr", "acme/api#7", "--pr", "acme/api#8")

  assert.equal(r.status, 2)
  assert.match(r.stderr, /two PRs of one repository \(acme\/api\)/)
  assert.equal(calls.length, 0)
})

test("LF4: a bare --pr stops with exit 2 instead of reviewing the working tree", () => {
  const env = setup()
  env.repo("api", "https://github.com/acme/api.git", "src/a.js", "x\n")

  const { r, calls } = env.review(env.ws, "--pr")

  assert.equal(r.status, 2)
  assert.match(r.stderr, /--pr needs a PR/)
  assert.equal(calls.length, 0)
})
