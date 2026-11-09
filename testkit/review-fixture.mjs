// The test-review fixture: a small node:test package stored as two patches, so a bare
// `node --test` at the repo root never runs it. materialize() turns it into a git repo with the
// base committed and the change staged; applyCheck() applies one answer-key check to that tree;
// childEnv() is the environment a nested `node --test` needs to report honestly.
//
// CLI: node testkit/review-fixture.mjs [dir]   materialises into dir (default: a new temp dir)

import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = fileURLToPath(new URL(".", import.meta.url))
const FIXTURE_DIR = resolve(HERE, "../test/fixtures/test-review")
export const KEY_PATH = join(FIXTURE_DIR, "answer-key.json")
const PIN = join(HERE, "pin-clock.mjs")

/** The fixture's own clock: the date the suite is green as committed. */
const FIXTURE_NOW = "2026-11-08T00:00:00Z"

const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })

/** git init; apply and commit base.patch; apply change.patch and stage it, uncommitted. */
export function materialize(dir) {
  mkdirSync(dir, { recursive: true })
  if (readdirSync(dir).length) throw new Error(`materialize: ${dir} is not empty`)
  git(dir, "init", "-q")
  git(dir, "config", "user.email", "fixture@example.com")
  git(dir, "config", "user.name", "fixture")
  git(dir, "config", "commit.gpgsign", "false")
  git(dir, "apply", join(FIXTURE_DIR, "base.patch"))
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", "base")
  git(dir, "apply", join(FIXTURE_DIR, "change.patch"))
  git(dir, "add", "-A")
  return dir
}

/**
 * Applies one key check to a materialised tree. An edit (survives, killed, fix) replaces `from`
 * with `to` on `line`; a refactor renames `from` to `to` throughout `file`, anchored on `line`.
 * Either throws unless `from` occurs exactly once on that line. A clock check edits nothing.
 */
export function applyCheck(dir, check) {
  if (check.kind === "clock") return
  const path = join(dir, check.file)
  const lines = readFileSync(path, "utf8").split("\n")
  const at = lines[check.line - 1] ?? ""
  if (at.split(check.from).length !== 2) throw new Error(`does not apply: ${check.file}:${check.line}`)
  const edited = check.kind === "refactor"
    ? lines.map((l) => l.split(check.from).join(check.to))
    : lines.map((l, i) => (i === check.line - 1 ? l.replace(check.from, () => check.to) : l))
  writeFileSync(path, edited.join("\n"))
}

/**
 * Env for a nested `node --test`. Drops NODE_TEST_CONTEXT, which otherwise makes the child
 * exit 0 with no output even when a test fails, and pins Date.now to `now` via --import.
 */
export function childEnv(base = process.env, { now = FIXTURE_NOW } = {}) {
  const env = { ...base }
  delete env.NODE_TEST_CONTEXT
  env.NODE_OPTIONS = `--import=${pathToFileURL(PIN).href}`
  env.REVIEW_FIXTURE_NOW = now
  return env
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), "test-review-fixture-"))
  materialize(dir)
  process.stdout.write(`${dir}\n`)
}
