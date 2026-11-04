import { after, test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { diffHash } from "../../src/loop-review/context.mjs"

const BIN = new URL("../../bin/loop-review.mjs", import.meta.url).pathname
const GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim()
const temps = []
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }) })

// A temp repo with `.reviews/` ignored and one uncommitted change, and a PATH holding only git
// and, unless `claude` is null, a fake `claude` that prints an empty discovery payload.
function setup({ claude = "ok" } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "loop-archive-repo-"))
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args])
  git("init", "-q")
  writeFileSync(join(repo, ".gitignore"), ".reviews/\n")
  writeFileSync(join(repo, "a.js"), "export const a = 1\n")
  git("add", ".")
  git("commit", "-qm", "init")
  writeFileSync(join(repo, "a.js"), "export const a = 2\n")
  const bin = mkdtempSync(join(tmpdir(), "loop-archive-bin-"))
  symlinkSync(GIT, join(bin, "git"))
  if (claude) {
    const envelope = { type: "result", is_error: false, result: "{}", structured_output: { findings: [], cells: [] }, usage: {} }
    const body = claude === "sleep"
      ? "setTimeout(() => {}, 30000)"
      : `process.stdout.write(${JSON.stringify(JSON.stringify(envelope))}); process.stderr.write("fake stderr")`
    writeFileSync(join(bin, "claude"), `#!${process.execPath}\n${body}\n`)
    chmodSync(join(bin, "claude"), 0o755)
  }
  temps.push(repo, bin)
  return { repo, bin }
}

const review = ({ repo, bin }, ...args) =>
  spawnSync(process.execPath, [BIN, "--repo", repo, ...args], { encoding: "utf8", env: { ...process.env, PATH: bin } })

const archiveOf = (repo) => {
  const runs = readdirSync(join(repo, ".reviews")).filter((n) => !n.endsWith(".md"))
  assert.equal(runs.length, 1, `expected one archive, got ${runs}`)
  return join(repo, ".reviews", runs[0])
}

test("a default run archives the diff, each call and the findings before the report", () => {
  const env = setup()
  const r = review(env, "--json")
  const out = JSON.parse(r.stdout)
  const dir = archiveOf(env.repo)
  assert.deepEqual(out.archive, { dir })
  for (const f of [
    "meta.json", "events.jsonl", "diff.patch", "sources/context/system-prefix.md",
    "sources/pass-1/prompt.md", "sources/pass-1/stdout.json", "sources/pass-1/stderr.txt", "sources/pass-1/process.json",
    "findings/pass-1.json", "findings/final.json",
  ]) assert.ok(existsSync(join(dir, f)), `missing ${f}`)
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"))
  assert.equal(diffHash(readFileSync(join(dir, "diff.patch"), "utf8")), meta.diffHash)
  assert.ok(existsSync(join(env.repo, ".reviews", `loop-review-${meta.diffHash}.md`)), "the run's diffHash names the report")
  assert.equal(readFileSync(join(dir, "sources/pass-1/stderr.txt"), "utf8"), "fake stderr")
  const proc = JSON.parse(readFileSync(join(dir, "sources/pass-1/process.json"), "utf8"))
  assert.deepEqual([proc.status, proc.signal, proc.error, proc.state], [0, null, null, "ok"])
  const events = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  assert.equal(events.at(-1).type, "terminal")
  assert.ok(events.some((e) => e.type === "pass.finish" && e.state === "ok"))
  const report = readFileSync(join(env.repo, ".reviews", `loop-review-${meta.diffHash}.md`), "utf8")
  assert.ok(report.includes(`Archive: .reviews/${dir.split("/").at(-1)}`))
})

test("a runner that times out leaves its signal and status in process.json", () => {
  const env = setup({ claude: "sleep" })
  review(env, "--timeout", "0.5")
  const proc = JSON.parse(readFileSync(join(archiveOf(env.repo), "sources/pass-1/process.json"), "utf8"))
  assert.equal(proc.signal, "SIGTERM")
  assert.equal(proc.status, null)
  assert.equal(proc.state, "timeout")
})

test("a missing runner binary leaves ENOENT in process.json", () => {
  const env = setup({ claude: null })
  review(env)
  const proc = JSON.parse(readFileSync(join(archiveOf(env.repo), "sources/pass-1/process.json"), "utf8"))
  assert.equal(proc.error.code, "ENOENT")
})

for (const flag of ["--no-file", "--no-archive"]) {
  test(`${flag} creates no .reviews/ archive`, () => {
    const env = setup()
    const r = review(env, flag, "--json", ...(flag === "--no-archive" ? ["--out", join(env.bin, "r.md")] : []))
    assert.deepEqual(JSON.parse(r.stdout).archive, { skipped: flag })
    assert.ok(!existsSync(join(env.repo, ".reviews")))
  })
}
