#!/usr/bin/env node
// The uncommitted diff of a workspace for /consensus-review §1: a folder that is not itself in a git
// repository but holds several (a feature spread across repositories is reviewed as one change).
//
//   workspace-diff.mjs --wd <WD> --root <dir>
//
// Finds the git repositories at depth 1 and 2 under --root (not below a repository, not in dot
// directories or node_modules; symlinked checkouts count), and per repository `git diff HEAD` with
// every path prefixed by the repository's directory relative to --root, so the one diff.patch reads
// like a diff of --root. Writes <WD>/diff.patch (the changed repositories, in path order) and
// <WD>/workspace.json, prints the latter, exit 0 — also when nothing changed (`changed` is empty).
// Exit 2 with the reason on stderr: a usage error, --root inside a git repository, no repository
// found, or a git failure (an unborn HEAD is `skipped: "no commits"`, not a failure).

import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { workspaceDiff } from "./lib/feature.mjs"

const USAGE = "usage: workspace-diff.mjs --wd <WD> --root <dir>"

const fail = (message) => {
  process.stderr.write(`${message}\n`)
  return 2
}

export function main(argv) {
  let values
  try {
    ({ values } = parseArgs({ args: argv, options: { wd: { type: "string" }, root: { type: "string" } } }))
  } catch (error) {
    return fail(`${error.message}\n${USAGE}`)
  }
  if (!values.wd || !values.root || !existsSync(values.wd)) return fail(USAGE)
  if (!existsSync(values.root) || !statSync(values.root).isDirectory()) return fail(`workspace: ${values.root}: not a directory`)
  let result
  try {
    result = workspaceDiff(realpathSync(values.root))
  } catch (error) {
    return fail(String(error?.message ?? error))
  }
  const { diffText, ...workspace } = result
  writeFileSync(join(values.wd, "diff.patch"), diffText)
  const text = `${JSON.stringify(workspace, null, 2)}\n`
  writeFileSync(join(values.wd, "workspace.json"), text)
  process.stdout.write(text)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
