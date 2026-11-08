// scripts/plan-input.mjs: `prepare` (input validation, the synthesized diff, doc.json) and `report`
// (the report path). Expected values come from "Other decisions: Input validation, Diff label,
// Doc-only mode, Report" and the I rows of .omc/plans/issue-4-plan-review.md.

import { after, test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SCRIPT = new URL("../../scripts/plan-input.mjs", import.meta.url).pathname

const dirs = []
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

const git = (repo, ...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" })

/** A temp root with an empty `wd/` and an `invoke/` dir, which is a git repo with one commit when `repo`. */
function space({ repo = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plan-input-")))
  dirs.push(root)
  const wd = join(root, "wd")
  const invoke = join(root, "invoke")
  mkdirSync(wd)
  mkdirSync(invoke)
  if (repo) {
    git(invoke, "init", "-q")
    git(invoke, "config", "user.email", "t@example.com")
    git(invoke, "config", "user.name", "t")
    writeFileSync(join(invoke, "README"), "r\n")
    git(invoke, "add", "-A")
    git(invoke, "commit", "-q", "-m", "init")
  }
  return { root, wd, invoke }
}

const put = (root, path, content) => {
  mkdirSync(join(root, path, ".."), { recursive: true })
  writeFileSync(join(root, path), content)
}

const run = (args, options = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", ...options })
const prepare = (ws, doc) => run(["prepare", "--wd", ws.wd, "--invoke", ws.invoke, "--doc", doc])
const docJson = (ws) => JSON.parse(readFileSync(join(ws.wd, "doc.json"), "utf8"))

/** Exit 2, exactly one stderr line, and an untouched $WD. */
const assertRefused = (ws, result, message) => {
  assert.equal(result.status, 2, result.stderr)
  assert.equal(result.stderr, `${message}\n`)
  assert.deepEqual(readdirSync(ws.wd), [])
}

test("I1: a doc in the repo is labelled by its repo path, with the new-file diff", () => {
  const ws = space()
  put(ws.invoke, "docs/p.md", "a\nb\n")
  const r = prepare(ws, "docs/p.md")
  assert.equal(r.status, 0, r.stderr)
  const doc = docJson(ws)
  assert.deepEqual(doc, {
    label: "docs/p.md", path: join(ws.invoke, "docs/p.md"), bytes: 4, lines: 2, repo: ws.invoke, inRepo: true, invoke: ws.invoke,
  })
  assert.deepEqual(JSON.parse(r.stdout), doc)
  assert.equal(readFileSync(join(ws.wd, "diff.patch"), "utf8"),
    "diff --git a/docs/p.md b/docs/p.md\nnew file mode 100644\n--- /dev/null\n+++ b/docs/p.md\n@@ -0,0 +1,2 @@\n+a\n+b\n")
  assert.equal(existsSync(join(ws.wd, "doc-cwd")), false)
})

test("I2b: a ~/ path is resolved against the home directory, not INVOKE", () => {
  const ws = space()
  put(ws.root, "home/notes/design.md", "step one\n")
  const r = run(["prepare", "--wd", ws.wd, "--invoke", ws.invoke, "--doc", "~/notes/design.md"],
    { env: { ...process.env, HOME: join(ws.root, "home") } })
  assert.equal(r.status, 0, r.stderr)
  const doc = docJson(ws)
  assert.equal(doc.path, join(ws.root, "home/notes/design.md"))
  assert.equal(doc.label, ".plan-review/design.md")
})

test("I2: a doc outside the repo is labelled .plan-review/<basename>", () => {
  const ws = space()
  put(ws.root, "x/plan.md", "step one\n")
  const r = prepare(ws, join(ws.root, "x/plan.md"))
  assert.equal(r.status, 0, r.stderr)
  const doc = docJson(ws)
  assert.equal(doc.label, ".plan-review/plan.md")
  assert.equal(doc.inRepo, false)
  assert.equal(doc.repo, ws.invoke)
  assert.match(readFileSync(join(ws.wd, "diff.patch"), "utf8"), /^\+\+\+ b\/\.plan-review\/plan\.md$/m)
})

test("I3: a non-git INVOKE is doc-only: repo null and doc-cwd holds only the copy", () => {
  const ws = space({ repo: false })
  put(ws.invoke, "plan.md", "step one\n")
  const r = prepare(ws, "plan.md")
  assert.equal(r.status, 0, r.stderr)
  const doc = docJson(ws)
  assert.equal(doc.repo, null)
  assert.equal(doc.label, ".plan-review/plan.md")
  assert.deepEqual(readdirSync(join(ws.wd, "doc-cwd")), ["plan.md"])
  assert.equal(readFileSync(join(ws.wd, "doc-cwd/plan.md"), "utf8"), "step one\n")
})

test("I4: a missing path stops and writes nothing", () => {
  const ws = space()
  assertRefused(ws, prepare(ws, "docs/none.md"), "plan-review: docs/none.md: no such file")
})

test("I5: a directory stops", () => {
  const ws = space()
  mkdirSync(join(ws.invoke, "docs"))
  assertRefused(ws, prepare(ws, "docs"), "plan-review: docs: not a regular file")
})

for (const [name, content] of [["0 bytes", ""], ["whitespace only", "  \n\n"]]) {
  test(`I6: ${name} is an empty document`, () => {
    const ws = space()
    put(ws.invoke, "p.md", content)
    assertRefused(ws, prepare(ws, "p.md"), "plan-review: p.md: empty document")
  })
}

test("I7: exactly 131072 bytes is accepted", () => {
  const ws = space()
  put(ws.invoke, "p.md", "a".repeat(131072))
  const r = prepare(ws, "p.md")
  assert.equal(r.status, 0, r.stderr)
  assert.equal(docJson(ws).bytes, 131072)
})

test("I8: 131073 bytes is too large", () => {
  const ws = space()
  put(ws.invoke, "p.md", "a".repeat(131073))
  assertRefused(ws, prepare(ws, "p.md"), "plan-review: p.md: too large (over 131072 bytes)")
})

for (const [name, content] of [["a NUL byte", Buffer.from("a\0b\n")], ["the invalid UTF-8 byte 0xff", Buffer.from([0x61, 0xff, 0x0a])]]) {
  test(`I9: ${name} is not a text file`, () => {
    const ws = space()
    put(ws.invoke, "p.md", content)
    assertRefused(ws, prepare(ws, "p.md"), "plan-review: p.md: not a text file")
  })
}

test("I10: no trailing newline ends the diff with the no-newline marker", () => {
  const ws = space()
  put(ws.invoke, "p.md", "a\nb")
  assert.equal(prepare(ws, "p.md").status, 0)
  assert.equal(docJson(ws).lines, 2)
  assert.ok(readFileSync(join(ws.wd, "diff.patch"), "utf8").endsWith("@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file\n"))
})

test("I11: a symlink to a regular file is followed and labelled by the symlink's path", () => {
  const ws = space()
  put(ws.invoke, "docs/real.md", "a\nb\n")
  symlinkSync(join(ws.invoke, "docs/real.md"), join(ws.invoke, "docs/link.md"))
  const r = prepare(ws, "docs/link.md")
  assert.equal(r.status, 0, r.stderr)
  assert.equal(docJson(ws).label, "docs/link.md")
  assert.match(readFileSync(join(ws.wd, "diff.patch"), "utf8"), /^\+\+\+ b\/docs\/link\.md$/m)
})

test("I12: an untracked, gitignored doc is accepted and no tracked state is reported", () => {
  const ws = space()
  put(ws.invoke, ".gitignore", ".omc/\n")
  put(ws.invoke, ".omc/plans/p.md", "a\nb\n")
  const r = prepare(ws, ".omc/plans/p.md")
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(Object.keys(docJson(ws)), ["label", "path", "bytes", "lines", "repo", "inRepo", "invoke"])
  assert.equal(docJson(ws).label, ".omc/plans/p.md")
})

// ---------------------------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------------------------

const DATE = (() => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
})()

/** A prepared docs/p.md and a final settings.json whose `out` is `out`. */
function prepared(out) {
  const ws = space()
  put(ws.invoke, "docs/p.md", "a\nb\n")
  assert.equal(prepare(ws, "docs/p.md").status, 0)
  writeFileSync(join(ws.wd, "settings.json"), JSON.stringify({ settings: { out } }))
  return ws
}
const report = (ws, options) => {
  const r = run(["report", "--wd", ws.wd], options)
  assert.equal(r.status, 0, r.stderr)
  return docJson(ws).report
}

test("I13: a second report on the same day, after the first was written, takes -2", () => {
  const ws = prepared({ value: "default", source: "default" })
  const first = report(ws)
  assert.equal(first, join(ws.invoke, `.reviews/plan-review-p-${DATE}.md`))
  writeFileSync(first, "# report\n")
  assert.equal(report(ws), join(ws.invoke, `.reviews/plan-review-p-${DATE}-2.md`))
  assert.equal(readFileSync(first, "utf8"), "# report\n")
})

test("I14: out=none from a profile gives report null and writes no file", () => {
  const ws = prepared({ value: "none", source: "profile" })
  assert.equal(report(ws), null)
  assert.equal(existsSync(join(ws.invoke, ".reviews")), false)
})

test("I15: a relative out directory resolves against doc.json invoke, not the process cwd", () => {
  const ws = prepared({ value: "reviews/", source: "profile" })
  mkdirSync(join(ws.invoke, "reviews"))
  const elsewhere = join(ws.root, "elsewhere")
  mkdirSync(elsewhere)
  assert.equal(report(ws, { cwd: elsewhere }), join(ws.invoke, `reviews/plan-review-p-${DATE}.md`))
  assert.deepEqual(readdirSync(elsewhere), [])
})

test("I16: two overlapping reports with nothing written between them get distinct empty placeholders", () => {
  const ws = prepared({ value: "default", source: "default" })
  const first = report(ws)
  const second = report(ws)
  assert.equal(first, join(ws.invoke, `.reviews/plan-review-p-${DATE}.md`))
  assert.equal(second, join(ws.invoke, `.reviews/plan-review-p-${DATE}-2.md`))
  assert.equal(readFileSync(first, "utf8"), "")
  assert.equal(readFileSync(second, "utf8"), "")
})

test("report: an explicit file path is used as given, with no placeholder and no suffix", () => {
  const ws = prepared({ value: "out/review.md", source: "flag" })
  assert.equal(report(ws), join(ws.invoke, "out/review.md"))
  assert.equal(existsSync(join(ws.invoke, "out")), false)
})
