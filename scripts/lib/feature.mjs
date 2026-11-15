// One feature spread over several repositories, as one diff: a workspace folder's uncommitted changes,
// or several PRs (one per repository). Every path carries its repository's directory relative to the
// root, so the diff reads like a diff of the root and `file:line` stays readable from there.
// Shared by scripts/workspace-diff.mjs, scripts/feature-diff.mjs and bin/loop-review.mjs.

import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, relative } from "node:path"
import { originRepo, parseScope, prRemote, resolveTarget } from "../../src/loop-review/context.mjs"

export const MAX_DEPTH = 2
const SKIP_DIRS = new Set(["node_modules"])
const BIG = 256 * 1024 * 1024

const git = (cwd, args, run = spawnSync) =>
  run("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: BIG })

const isDir = (path) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const withNewline = (text) => (!text || text.endsWith("\n") ? text : `${text}\n`)

/** The top of the git work tree holding `dir`, or null. */
export function workTree(dir, run = spawnSync) {
  const top = git(dir, ["rev-parse", "--show-toplevel"], run)
  return top.status === 0 && top.stdout.trim() ? top.stdout.trim() : null
}

/** The repositories under `root` (absolute paths, sorted), at depth 1..MAX_DEPTH, never inside one. */
export function findRepos(root, depth = 1) {
  const repos = []
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return repos
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue
    const dir = join(root, entry.name)
    // A symlinked checkout counts; statSync follows the link.
    if (!entry.isDirectory() && !(entry.isSymbolicLink() && isDir(dir))) continue
    if (existsSync(join(dir, ".git"))) repos.push(dir)
    else if (depth < MAX_DEPTH) repos.push(...findRepos(dir, depth + 1))
  }
  return repos
}

/**
 * The uncommitted changes of every repository under `root` (which must not be in a work tree),
 * untracked files included as new-file diffs: a feature made of new files must reach the reviewers
 * and the triage. `untracked` still lists them. Throws with the reason.
 */
export function workspaceDiff(root, { run = spawnSync } = {}) {
  if (workTree(root, run)) throw new Error(`workspace: ${root} is inside a git repository: review it as uncommitted changes`)
  const found = findRepos(root)
  if (!found.length) throw new Error(`workspace: no git repository under ${root} (searched ${MAX_DEPTH} levels)`)
  const repos = []
  const patches = []
  for (const dir of found) {
    const path = relative(root, dir)
    const prefixes = [`--src-prefix=a/${path}/`, `--dst-prefix=b/${path}/`]
    if (git(dir, ["rev-parse", "--verify", "-q", "HEAD"], run).status !== 0) {
      // Only an unborn HEAD is "no commits"; dubious ownership or a broken repository stops the run.
      const unborn = git(dir, ["symbolic-ref", "-q", "HEAD"], run)
      if (unborn.status !== 0) throw new Error(`workspace: git failed in ${path}: ${unborn.stderr.trim().split("\n")[0] || "HEAD unreadable"}`)
      repos.push({ path, branch: null, head: null, files: 0, untracked: [], skipped: "no commits" })
      continue
    }
    const diff = git(dir, ["diff", "HEAD", "-M", "--no-color", "--no-ext-diff", ...prefixes], run)
    const untracked = git(dir, ["ls-files", "-z", "--others", "--exclude-standard"], run)
    if (diff.status !== 0 || untracked.status !== 0) {
      throw new Error(`workspace: git failed in ${path}: ${(diff.stderr || untracked.stderr).trim().split("\n")[0]}`)
    }
    const files = untracked.stdout.split("\0").filter(Boolean)
    let text = diff.stdout
    // `--no-index` exits 1 exactly when the files differ, so its status is not an error here.
    for (const file of files) text += git(dir, ["diff", "--no-color", "--no-ext-diff", "--no-index", ...prefixes, "--", "/dev/null", file], run).stdout
    repos.push({
      path,
      branch: git(dir, ["rev-parse", "--abbrev-ref", "HEAD"], run).stdout.trim() || null,
      head: git(dir, ["rev-parse", "--short", "HEAD"], run).stdout.trim() || null,
      files: (diff.stdout.match(/^diff --git /gm) ?? []).length,
      untracked: files.map((file) => `${path}/${file}`),
      skipped: null,
    })
    if (text) patches.push(withNewline(text))
  }
  const changed = repos.filter((r) => r.files || r.untracked.length).map((r) => r.path)
  return { root, repos, changed, diffText: patches.join("") }
}

/** `a/<path>` → `a/<prefix>/<path>` keeping git's quoting (`"a/x\ty"`); null (`/dev/null`) stays. */
const prefixSide = (side, prefix) => {
  const m = /^("?)([ab])\/(.*)$/s.exec(side)
  return m ? `${m[1]}${m[2]}/${prefix}/${m[3]}` : side
}

/** The two sides of a `diff --git` line's rest (`a/P b/P`, quoted or not). */
const splitSides = (rest) => {
  if (rest.startsWith('"')) {
    // The closing quote of git's C-quoting, skipping escapes such as `\"`.
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === "\\") i++
      else if (rest[i] === '"') return rest[i + 1] === " " ? [rest.slice(0, i + 1), rest.slice(i + 2)] : null
    }
    return null
  }
  // Unquoted and unrenamed: both halves are equal, which survives a path containing " b/".
  const half = (rest.length - 1) / 2
  if (Number.isInteger(half) && rest[half] === " " && rest.slice(2, half) === rest.slice(half + 3)) {
    return [rest.slice(0, half), rest.slice(half + 1)]
  }
  const at = rest.lastIndexOf(" b/") >= 0 ? rest.lastIndexOf(" b/") : rest.lastIndexOf(' "b/')
  return at > 0 ? [rest.slice(0, at), rest.slice(at + 1)] : null
}

/** A git diff with every header path under `prefix/`; hunk content is never touched. */
export function prefixDiff(diffText, prefix) {
  if (!prefix) return diffText
  let header = false
  let sides = null
  return diffText.split("\n").map((line) => {
    if (line.startsWith("diff --git ")) {
      header = true
      sides = splitSides(line.slice("diff --git ".length))
      return sides ? `diff --git ${prefixSide(sides[0], prefix)} ${prefixSide(sides[1], prefix)}` : line
    }
    if (!header) return line
    if (line.startsWith("@@")) {
      header = false
      return line
    }
    const file = /^(--- |\+\+\+ )(.*)$/.exec(line)
    if (file) return file[1] + prefixSide(file[2], prefix)
    const moved = /^((?:rename|copy) (?:from|to) )("?)(.*)$/.exec(line)
    if (moved) return `${moved[1]}${moved[2]}${prefix}/${moved[3]}`
    // The sides are the `diff --git` ones (or /dev/null): a name containing " and " cannot split them.
    if (line.startsWith("Binary files ") && sides) {
      for (const a of [sides[0], "/dev/null"]) {
        for (const b of [sides[1], "/dev/null"]) {
          if (line === `Binary files ${a} and ${b} differ`) return `Binary files ${prefixSide(a, prefix)} and ${prefixSide(b, prefix)} differ`
        }
      }
    }
    return line
  }).join("\n")
}

/** `owner/repo` of a scope's repository (`host/owner/repo` for a URL). */
const ownerRepo = (scope) => scope.repo.split("/").slice(-2).join("/")

/** The origin host of `dir`, or null. */
const originHost = (dir, run) => {
  const url = run("git", ["config", "--get", "remote.origin.url"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  return url.status === 0 ? originRepo(url.stdout.trim())?.split("/")[0] ?? null : null
}

/**
 * Several PRs as one feature. The root is `invoke` when it is no work tree, else the folder holding
 * that work tree, where sibling checkouts usually live (not the home directory or `/`: then the root
 * is the work tree itself, path `.`, and no siblings are searched). Each PR maps to the checkout under the root whose remote names its
 * repository (its prefix is that directory), else to `@<owner>/<repo>` — a prefix no local folder
 * has, so no agent reads unrelated code for it (diff-only for that PR). Every target needs its
 * repository (`owner/repo#N` or a URL), and two PRs of one repository stop the run.
 *
 * Each diff comes from gh, else the public URL; the local-clone path (which needs `base`) is used
 * only when exactly one PR has a checkout, because one `base` cannot be the base of several PRs —
 * a wrong one gives a silently wrong diff. `baseUsedFor` names that PR's path, or is null.
 * Throws with the reason.
 */
export function featureDiff({ invoke, targets, workDir, base = null, run = spawnSync }) {
  const top = workTree(invoke, run)
  const parent = top ? dirname(top) : null
  const shallow = parent && [homedir(), "/"].includes(realpathSync(parent))
  const root = realpathSync(top ? (shallow ? top : parent) : invoke)
  const repos = top && shallow ? [root] : findRepos(root)
  // The work tree itself as the root (shallow) is path `.`: its paths stay as they are.
  const rootOf = (dir) => relative(root, dir) || "."
  const plans = []
  const byRepo = new Map()
  for (const target of targets) {
    const scope = parseScope(target)
    if (!scope?.pr) throw new Error(`${target}: not a PR target`)
    if (!scope.repo) throw new Error(`${target}: several PRs need owner/repo#N or a URL for each`)
    const id = ownerRepo(scope)
    if (byRepo.has(id)) throw new Error(`${byRepo.get(id)} and ${target}: two PRs of one repository (${id}); review them one at a time`)
    byRepo.set(id, target)
    const checkout = repos.find((dir) => prRemote(dir, scope, run)) ?? null
    plans.push({ target, scope, checkout, path: checkout ? rootOf(checkout) : `@${id}` })
  }
  const clonePath = base && plans.filter((p) => p.checkout).length === 1 ? plans.find((p) => p.checkout) : null
  const prs = plans.map(({ target, scope, checkout, path }) => {
    // Without the clone path, `owner/repo#N` still gets a public URL on its checkout's host.
    const host = checkout ? originHost(checkout, run) : null
    const prTarget = !scope.ref && host ? `https://${host}/${ownerRepo(scope)}/pull/${scope.pr}` : target
    const useClone = clonePath?.target === target
    const resolved = resolveTarget({ repo: useClone ? checkout : null, mode: "pr", prTarget, workDir, base: useClone ? base : null, run })
    return {
      target,
      repo: scope.repo,
      path,
      checkout: Boolean(checkout),
      mode: resolved.mode ?? null,
      headSha: resolved.headSha ?? null,
      files: (resolved.diffText.match(/^diff --git /gm) ?? []).length,
      diffText: withNewline(prefixDiff(resolved.diffText, path === "." ? "" : path)),
    }
  })
  return { root, prs, baseUsedFor: clonePath?.path ?? null, diffText: prs.map((p) => p.diffText).join("") }
}
