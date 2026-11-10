// Seeded review fixtures under test/fixtures/<name>/: a small package stored as two patches, so a
// bare `node --test` at the repo root never runs it. materialize() turns one into a git repo with
// the base committed and the change staged; applyCheck() applies one test-review key check to that
// tree; childEnv() is the environment a nested `node --test` needs to report honestly.
//
// CLI: node testkit/review-fixture.mjs [dir] [name] [change]   materialises fixture `name`
// (default test-review) with its `change` patch (default change.patch) into dir (default: a new
// temp dir)

import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = fileURLToPath(new URL(".", import.meta.url))
const fixtureDir = (name) => resolve(HERE, "../test/fixtures", name)
export const keyPath = (name = "test-review") => join(fixtureDir(name), "answer-key.json")
export const KEY_PATH = keyPath()
const PIN = join(HERE, "pin-clock.mjs")

/** The fixture's own clock: the date the suite is green as committed. */
const FIXTURE_NOW = "2026-11-08T00:00:00Z"

/** The base commit's author and subject. arch-review's reviewer reads `git log`, so it looks real. */
const BASE_COMMIT = {
  "test-review": { name: "fixture", email: "fixture@example.com", subject: "base" },
  "arch-review": { name: "Dana Kim", email: "dana@shopfront.dev", subject: "Release 1.4.0" },
  "arch-review-hard": { name: "Sam Okafor", email: "sam@meterly.dev", subject: "Release 2.3.0" },
}

const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })

/**
 * git init; apply and commit base.patch; apply the change (`change`, default change.patch) and
 * stage it, uncommitted. With `include`, only the change's hunks for those paths are applied (none
 * for an empty list).
 */
export function materialize(dir, { fixture = "test-review", change = "change.patch", include } = {}) {
  mkdirSync(dir, { recursive: true })
  if (readdirSync(dir).length) throw new Error(`materialize: ${dir} is not empty`)
  const commit = BASE_COMMIT[fixture]
  if (!commit) throw new Error(`materialize: unknown fixture ${fixture}`)
  git(dir, "init", "-q")
  git(dir, "config", "user.email", commit.email)
  git(dir, "config", "user.name", commit.name)
  git(dir, "config", "commit.gpgsign", "false")
  git(dir, "apply", join(fixtureDir(fixture), "base.patch"))
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", commit.subject)
  if (include?.length !== 0) {
    git(dir, "apply", ...(include ?? []).map((path) => `--include=${path}`), join(fixtureDir(fixture), change))
    git(dir, "add", "-A")
  }
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
  const fixture = process.argv[3] ?? "test-review"
  const dir = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), `${fixture}-fixture-`))
  materialize(dir, { fixture, change: process.argv[4] })
  process.stdout.write(`${dir}\n`)
}
