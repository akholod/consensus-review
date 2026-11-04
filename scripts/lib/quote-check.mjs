// Checks a sceptic's citation {file, line, quote} against the code the review covers: first the
// diff's new side, then (when the clone can be trusted) the file at the reviewed head. Pure apart
// from the reader `makeReadHeadFile` builds; it reads only, never checks out or fetches.

import { spawnSync } from "node:child_process"
import { readFileSync, realpathSync, statSync } from "node:fs"
import { join, sep } from "node:path"
import { parseDiff } from "../../src/loop-review/context.mjs"

const DRIFT = 5
const MIN_QUOTE = 10
const MAX_QUOTE = 2000
const MAX_FILE = 2 * 1024 * 1024
const SHA_RE = /^[0-9a-f]{40}$/

const fail = (reason) => ({ verified: false, reason, source: null })

/** Relative, no `..` segment, no leading `./`, not absolute. */
export function safePath(path) {
  return typeof path === "string" && path !== "" && !path.includes("\0") && !path.startsWith("/")
    && !path.startsWith("./") && !path.split("/").includes("..")
}

/** New-side lines of `file` in the diff as Map<lineNo, text>; null when the file has no new side there. */
export function newSideLines(diffText, file) {
  const entry = parseDiff(diffText ?? "").find((f) => f.newPath === file && !f.deleted)
  if (!entry) return null
  const lines = new Map()
  let lineNew = 0
  for (const line of entry.diff.split("\n")) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) { lineNew = Number(hunk[1]); continue }
    if (line.startsWith("-") || line.startsWith("\\")) continue
    if (lineNew > 0) lines.set(lineNew, line.slice(1))
    lineNew++
  }
  return lines
}

const normalise = (text) => text.split("\n").map((l) => l.trim().replace(/\s+/g, " ")).filter(Boolean).join("\n")

/**
 * Whether the quote sits in [line − 5, line + 5 + quoteLines − 1], i.e. it starts within ±5 of `line`.
 * A gap in `lines` (outside a hunk) splits the window, so a quote never spans one.
 */
function inWindow(lines, line, quote) {
  const want = normalise(quote)
  const hi = line + DRIFT + quote.split("\n").length - 1
  let run = []
  for (let n = Math.max(1, line - DRIFT); n <= hi + 1; n++) {
    if (n <= hi && lines.has(n)) { run.push(lines.get(n)); continue }
    if (run.length && normalise(run.join("\n")).includes(want)) return true
    run = []
  }
  return false
}

/** → {verified, reason, source: "diff"|"head"|null}. Never throws. */
export function checkCitation({ citation, diffText, readHeadFile }) {
  try {
    const { file, line: rawLine, quote } = citation ?? {}
    if (typeof file !== "string" || typeof quote !== "string"
      || (typeof rawLine !== "string" && typeof rawLine !== "number")) return fail("malformed citation")
    const digits = String(rawLine).match(/\d+/)
    if (!digits) return fail("line without number")
    const line = Number(digits[0])
    if (quote.includes("...") || quote.includes("…")) return fail("elided quote")
    if (quote.replace(/\s/g, "").length < MIN_QUOTE) return fail("quote too short")
    if (quote.length > MAX_QUOTE) return fail("quote too long")
    if (!safePath(file)) return fail("unsafe path")
    const diffLines = newSideLines(diffText, file)
    if (diffLines && inWindow(diffLines, line, quote)) return { verified: true, reason: null, source: "diff" }
    if (!readHeadFile) return fail(diffLines ? "quote not found in diff" : "cannot verify outside diff")
    const content = readHeadFile(file)
    if (typeof content !== "string") return fail("file not readable at head")
    const headLines = new Map(content.split("\n").map((text, i) => [i + 1, text]))
    return inWindow(headLines, line, quote) ? { verified: true, reason: null, source: "head" } : fail("quote not found")
  } catch {
    return fail("check failed")
  }
}

const git = (repo, args, options = {}) =>
  spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], ...options })

/**
 * Reader for files outside the diff. `headSha` is `worktree` (the working tree is the reviewed state)
 * or a 40-hex commit present in `repo` (blob reads at it). Anything else → null: no clone reads.
 */
export function makeReadHeadFile({ repo, headSha }) {
  if (!repo || typeof headSha !== "string") return null
  if (headSha === "worktree") {
    let root
    try { root = realpathSync(repo) } catch { return null }
    return (path) => {
      if (!safePath(path)) return null
      try {
        const real = realpathSync(join(root, path))
        if (!real.startsWith(root + sep)) return null
        const st = statSync(real)
        if (!st.isFile() || st.size > MAX_FILE) return null
        return readFileSync(real, "utf8")
      } catch {
        return null
      }
    }
  }
  if (!SHA_RE.test(headSha) || git(repo, ["cat-file", "-e", `${headSha}^{commit}`]).status !== 0) return null
  return (path) => {
    if (!safePath(path)) return null
    const object = `${headSha}:${path}`
    const size = git(repo, ["cat-file", "-s", object])
    if (size.status !== 0 || !(Number(size.stdout.trim()) <= MAX_FILE)) return null
    const blob = git(repo, ["cat-file", "blob", object], { maxBuffer: MAX_FILE })
    return blob.status === 0 && !blob.error ? blob.stdout : null
  }
}

/** The `verifyCitation(citation)` that decideSceptic takes. */
export function makeVerifyCitation({ diffText, repo, headSha }) {
  const readHeadFile = makeReadHeadFile({ repo, headSha })
  return (citation) => checkCitation({ citation, diffText, readHeadFile })
}
