#!/usr/bin/env node
// The PR diff for /consensus-review §1 when `gh` cannot give it.
//
//   pr-diff.mjs --wd <WD> --target <PR> [--repo <dir>] [--base <branch>]
//
// Tries `gh`, then a remote of the clone at --repo (default: the cwd) whose raw URL names the PR's
// repository — that path needs --base and full history, and adds objects but never a ref,
// FETCH_HEAD or config — then, for a URL or owner/repo#N, the public diff URL on the PR's own host
// (diff-only). Writes <WD>/diff.patch and prints `{"headSha","baseRef","mode"}` (mode
// gh|clone|curl), exit 0. Anything else prints the reason to stderr and exits 2, nothing written.

import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { resolveTarget } from "../src/loop-review/context.mjs"

const USAGE = "usage: pr-diff.mjs --wd <WD> --target <PR> [--repo <dir>] [--base <branch>]"
const OPTIONS = { wd: { type: "string" }, target: { type: "string" }, repo: { type: "string" }, base: { type: "string" } }

export function main(argv, { run = spawnSync, cwd = process.cwd() } = {}) {
  let values
  try {
    ({ values } = parseArgs({ args: argv, options: OPTIONS }))
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}\n`)
    return 2
  }
  if (!values.wd || !values.target) {
    process.stderr.write(`${USAGE}\n`)
    return 2
  }
  const top = run("git", ["rev-parse", "--show-toplevel"], { cwd: values.repo ?? cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  const repo = top.status === 0 ? top.stdout.trim() : null
  let resolved
  try {
    resolved = resolveTarget({ repo, mode: "pr", prTarget: values.target, workDir: values.wd, base: values.base ?? null, run })
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error).split("\n")[0]}\n`)
    return 2
  }
  writeFileSync(join(values.wd, "diff.patch"), resolved.diffText)
  const { headSha = null, baseRef = null, mode } = resolved
  process.stdout.write(`${JSON.stringify({ headSha, baseRef, mode })}\n`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
