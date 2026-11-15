#!/usr/bin/env node
// Several PRs, one per repository, as one feature for /consensus-review §1 and the standalone reviews.
//
//   feature-diff.mjs --wd <WD> --invoke <dir> --target <PR> --target <PR> [...] [--base <branch>]
//
// Each target is `owner/repo#N` or a PR URL. The root is --invoke when it is no git work tree, else
// the folder that holds that work tree. A PR whose repository has a checkout under the root (a remote
// naming it) gets that directory as its path prefix; otherwise an `@` prefix, diff-only for that
// PR (`@<owner>/<repo>`). Each diff comes from gh, else the public diff URL; the checkout with --base
// only when exactly one PR has a checkout (`baseUsedFor`). Writes <WD>/diff.patch (the PRs in the
// order given) and <WD>/feature.json `{root, baseUsedFor, prs: [{target, repo, path, checkout, mode,
// headSha, files}]}`, prints the latter, exit 0.
// Exit 2 with the reason on stderr: a usage error, a target without its repository, two PRs of one
// repository, or a PR whose diff cannot be had or is empty.

import { existsSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { featureDiff } from "./lib/feature.mjs"

const USAGE = "usage: feature-diff.mjs --wd <WD> --invoke <dir> --target <PR> --target <PR> [...] [--base <branch>]"
const OPTIONS = { wd: { type: "string" }, invoke: { type: "string" }, target: { type: "string", multiple: true }, base: { type: "string" } }

const fail = (message) => {
  process.stderr.write(`${message}\n`)
  return 2
}

export function main(argv) {
  let values
  try {
    ({ values } = parseArgs({ args: argv, options: OPTIONS }))
  } catch (error) {
    return fail(`${error.message}\n${USAGE}`)
  }
  const targets = values.target ?? []
  if (!values.wd || !existsSync(values.wd) || !values.invoke || targets.length < 2) return fail(USAGE)
  if (!existsSync(values.invoke) || !statSync(values.invoke).isDirectory()) return fail(`feature: ${values.invoke}: not a directory`)
  let result
  try {
    result = featureDiff({ invoke: resolve(values.invoke), targets, workDir: values.wd, base: values.base ?? null })
  } catch (error) {
    return fail(String(error?.message ?? error).split("\n")[0])
  }
  writeFileSync(join(values.wd, "diff.patch"), result.diffText)
  const feature = { root: result.root, baseUsedFor: result.baseUsedFor, prs: result.prs.map(({ diffText, ...pr }) => pr) }
  const text = `${JSON.stringify(feature, null, 2)}\n`
  writeFileSync(join(values.wd, "feature.json"), text)
  process.stdout.write(text)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
