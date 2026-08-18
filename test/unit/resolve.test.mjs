import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveTarget, parseDiff } from "../../src/loop-review/context.mjs"

const git = (repo, ...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" })

function repoWithHistory() {
  const dir = mkdtempSync(join(tmpdir(), "loop-review-resolve-"))
  git(dir, "init", "-q")
  git(dir, "config", "user.email", "t@t")
  git(dir, "config", "user.name", "t")
  mkdirSync(join(dir, "src"), { recursive: true })
  writeFileSync(join(dir, "src/a.js"), "export const a = 1\n")
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", "base")
  return dir
}

test("uncommitted mode includes untracked files, not just tracked edits", () => {
  const dir = repoWithHistory()
  try {
    writeFileSync(join(dir, "src/a.js"), "export const a = 2\n")   // tracked edit
    writeFileSync(join(dir, "src/brand-new.js"), "export const b = 1\n") // untracked
    const { diffText } = resolveTarget({ repo: dir, mode: "uncommitted" })
    const paths = parseDiff(diffText).map((f) => f.path)
    assert.ok(paths.includes("src/a.js"), "tracked edit must appear")
    assert.ok(
      paths.some((p) => p.endsWith("brand-new.js")),
      "an entirely new file must be reviewed, not silently skipped"
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("range mode honours the right-hand revision instead of HEAD", () => {
  const dir = repoWithHistory()
  try {
    git(dir, "checkout", "-q", "-b", "feature")
    writeFileSync(join(dir, "src/a.js"), "export const a = 2\n")
    git(dir, "commit", "-qam", "on feature")
    const featureSha = git(dir, "rev-parse", "HEAD").trim()

    git(dir, "checkout", "-q", "-")
    writeFileSync(join(dir, "src/other.js"), "export const c = 3\n")
    git(dir, "add", "-A")
    git(dir, "commit", "-qm", "on main only")

    // HEAD is now the main-only commit; the range must review the feature side.
    const { diffText } = resolveTarget({ repo: dir, mode: "range", range: `HEAD..${featureSha}` })
    const paths = parseDiff(diffText).map((f) => f.path)
    assert.deepEqual(paths, ["src/a.js"], "must review the range's right-hand side, not HEAD")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an unchanged worktree produces an empty diff", () => {
  const dir = repoWithHistory()
  try {
    assert.equal(resolveTarget({ repo: dir, mode: "uncommitted" }).diffText.trim(), "")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
