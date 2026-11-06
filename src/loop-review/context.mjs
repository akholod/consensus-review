// Deterministic review context: resolve a diff once, classify it, derive coverage cells,
// and assemble a byte-stable prompt prefix. Lenses are selected by scripts/lenses.mjs and stay
// out of the prefix, which the verifier also reads.
// Nothing here reasons about code — it only decides what the model is allowed to see.

import { execFileSync, spawnSync } from "node:child_process"
import { readFileSync, existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs"
import { createHash } from "node:crypto"
import { isAbsolute, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { SURFACE, RISK, HIGH_RISK, makeCell } from "./schema.mjs"

const MAX_ORIGINAL_LINES = 10_000

const git = (repo, ...args) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })

const gitTry = (repo, ...args) => {
  try { return git(repo, ...args) } catch { return null }
}

/**
 * Last new-side line the diff hunks actually reach. This is the bound anchors are checked
 * against: the reviewer only ever sees the diff and the pre-change files, so an anchor past the
 * supplied context cannot be evidence that anything was inspected. An earlier version added
 * arbitrary headroom, which accepted line 900 of a four-line file.
 */
function lastNewLine(section) {
  let max = 0
  for (const m of String(section).matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    max = Math.max(max, Number(m[1]) + (m[2] ? Number(m[2]) : 1) - 1)
  }
  return max
}

/**
 * Git quotes paths containing control or non-ASCII bytes in C style ("a\tb"). Left undecoded the
 * path failed to match and the whole file silently vanished from the review.
 */
function unquotePath(raw) {
  if (typeof raw !== "string") return null
  const text = raw.trim()
  if (!text.startsWith('"') || !text.endsWith('"')) return text
  const body = text.slice(1, -1)
  const bytes = []
  const pushText = (str) => { for (const b of Buffer.from(str, "utf8")) bytes.push(b) }
  const chars = [...body] // by code point, so a non-BMP name is not split into surrogates
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== "\\") { pushText(chars[i]); continue }
    const next = chars[++i]
    if (next === undefined) return null // trailing backslash: the path is malformed
    const simple = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", b: "\b", f: "\f", v: "\v", a: "\x07" }
    if (next in simple) { pushText(simple[next]); continue }
    if (/[0-7]/.test(next)) {
      // Consecutive octal escapes are the bytes of one UTF-8 sequence; decoding each in
      // isolation turned "\320\220" into "Ð" instead of "А".
      bytes.push(parseInt(chars.slice(i, i + 3).join(""), 8))
      i += 2
      continue
    }
    pushText(next)
  }
  return Buffer.from(bytes).toString("utf8")
}

/**
 * Decode a diff path token. The `a/`/`b/` prefix is synthetic only on `---`, `+++` and
 * `diff --git` lines; `rename from`/`rename to` carry the real path, so a file genuinely named
 * `a/old.js` must not be truncated to `old.js`.
 */
function stripPrefix(prefixed, verbatim) {
  if (prefixed != null) {
    const decoded = unquotePath(prefixed)
    return decoded == null ? null : decoded.replace(/^[ab]\//, "")
  }
  return unquotePath(verbatim)
}

/** Parse `git diff -M` into per-file records. */
export function parseDiff(raw) {
  const files = []
  for (const section of String(raw).split(/^(?=diff --git )/m)) {
    if (!section.startsWith("diff --git ")) continue
    // Binary files and mode-only changes carry no ---/+++ lines, so the `diff --git` header
    // is the only path source for them.
    // Capture the whole token including any quotes, so unquotePath can decode it before the
    // a/ or b/ prefix is stripped. Stripping quotes in the regex left it nothing to decode.
    const header = section.match(/^diff --git (\S+|"(?:[^"\\]|\\.)*") (\S+|"(?:[^"\\]|\\.)*")$/m)
    const minus = section.match(/^--- (.+)$/m)?.[1]
    const plus = section.match(/^\+\+\+ (.+)$/m)?.[1]
    const renameFrom = section.match(/^rename from (.+)$/m)?.[1] ?? null
    const renameTo = section.match(/^rename to (.+)$/m)?.[1] ?? null
    const oldPath = stripPrefix(
      minus && minus.trim() !== "/dev/null" ? minus : renameFrom == null ? header?.[1] ?? null : null,
      renameFrom
    )
    const newPath = stripPrefix(
      plus && plus.trim() !== "/dev/null" ? plus : renameTo == null ? header?.[2] ?? null : null,
      renameTo
    )
    const binary = /^Binary files |^GIT binary patch/m.test(section)
    const hunkStart = section.search(/^@@ /m)
    files.push({
      oldPath,
      newPath,
      path: newPath ?? oldPath,
      newFile: /^new file mode /m.test(section),
      deleted: /^deleted file mode /m.test(section),
      renamed: /^rename from /m.test(section),
      binary,
      diff: binary || hunkStart < 0 ? "" : section.slice(hunkStart),
      // Upper bound on the new-side line numbers this diff can speak about, from the last hunk
      // header plus its length. Generous on purpose — it exists to catch invented line numbers.
      maxLine: lastNewLine(section),
    })
  }
  return files
}

/** Map a changed line number range per file, so a finding's line can be checked against the diff. */
export function changedLines(fileDiff) {
  const added = []
  let lineNew = 0
  for (const line of String(fileDiff).split("\n")) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) { lineNew = Number(hunk[1]); continue }
    if (line.startsWith("+")) { added.push(lineNew); lineNew++ }
    else if (line.startsWith("-")) { /* old side only */ }
    else if (line.startsWith("\\")) { /* no newline marker */ }
    else lineNew++
  }
  return added
}

const GENERATED_RE = /(^|\/)(dist|build|vendor|node_modules)\/|\.min\.[a-z]+$|\.generated\.[a-z]+$|\.pb\.go$|_pb2\.py$|\.lock$|-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$|go\.sum$/

export function isGenerated(repo, path) {
  if (GENERATED_RE.test(path)) return true
  const out = gitTry(repo, "check-attr", "linguist-generated", "--", path) ?? ""
  return /: linguist-generated: (set|true)$/m.test(out)
}

/** Surface classification, mirroring the triage classes in commands/consensus-review.md §3.1. */
export function classify(path) {
  const p = String(path)
  if (/(^|\/)migrations?\//.test(p) || /\.sql$/.test(p)) return SURFACE.MIGRATION
  if (/(^|\/)(package\.json|go\.mod|Cargo\.toml|requirements\.txt|pyproject\.toml|pom\.xml|build\.gradle)$/.test(p)) return SURFACE.MANIFEST
  if (/(test|spec)/i.test(p) && /\.(js|mjs|ts|tsx|jsx|py|go|rb|java|rs)$/.test(p)) return SURFACE.TESTS
  if (/(^|\/)__tests__\//.test(p) || /_test\.go$/.test(p) || /(^|\/)test_[^/]+\.py$/.test(p)) return SURFACE.TESTS
  if (/\.(md|mdx|rst|txt|svg|png|jpe?g|gif|woff2?|csv|snap|po)$/.test(p) || /(^|\/)(docs|locales|__snapshots__|fixtures)\//.test(p) || /(^|\/)LICENSE$/.test(p)) return SURFACE.NON_CODE
  if (/\.(json|ya?ml|toml)$/.test(p) || /(^|\/)Dockerfile/.test(p) || /(^|\/)\.github\/workflows\//.test(p) || /\.tf$/.test(p)) return SURFACE.CONFIG
  return SURFACE.SOURCE
}

const AUTH_RE = /(^|\/)(auth|authz|authentication|authorization|permission|permissions|security|session|token|crypto|password)/i

/** Risk categories implied by a changed path. High-risk ones become mandatory cells. */
export function risksFor(path, surface) {
  const risks = new Set()
  if (surface === SURFACE.NON_CODE) return risks
  if (surface === SURFACE.TESTS) { risks.add(RISK.TESTS); return risks }
  risks.add(RISK.CORRECTNESS)
  risks.add(RISK.ERROR_HANDLING)
  if (surface === SURFACE.MIGRATION) risks.add(RISK.DATA)
  if (surface === SURFACE.MANIFEST) risks.add(RISK.SECURITY)
  if (AUTH_RE.test(path)) risks.add(RISK.SECURITY)
  if (/(^|\/)(api|routes?|controllers?|handlers?|schema|schemas|contracts?|proto|events?)\//i.test(path)) risks.add(RISK.CONTRACT)
  if (/(worker|queue|concurren|async|thread|lock|mutex)/i.test(path)) risks.add(RISK.CONCURRENCY)
  return risks
}

export function deriveCells(files) {
  const byId = new Map()
  // A pure rename or a mode change has no content to anchor evidence against, so it yields no
  // cell. It still appears in the prompt (see buildStaticPrefix) so the reviewer can see it.
  for (const f of files.filter((x) => !isMetadataOnly(x))) {
    const surface = classify(f.path)
    const touched = f.diff ? changedLines(f.diff) : []
    for (const risk of risksFor(f.path, surface)) {
      const id = `${surface}:${risk}`
      if (!byId.has(id)) byId.set(id, { ...makeCell(surface, risk, []), lines: {}, maxLine: {} })
      const cell = byId.get(id)
      cell.files.push(f.path)
      // Anchors are checked against these, so a real path with an invented line is caught.
      if (touched.length) cell.lines[f.path] = touched
      // An explicit 0 means "no inspectable lines in the supplied context" and must be kept,
      // not treated as "unknown, allow anything".
      cell.maxLine[f.path] = f.binary ? 0 : (f.maxLine ?? 0)
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/** A diff is trivial when nothing outside non-code changed. */
/** True when a section changed nothing inspectable: a pure rename or a mode-only change. */
export function isMetadataOnly(file) {
  if (file.binary) return false
  return file.diff !== undefined && !String(file.diff).trim()
}

export function isTrivial(files) {
  // Deliberately every file, including metadata-only ones: renaming an auth module is a change
  // worth reviewing even though it has no hunks to anchor evidence against.
  return files.every((f) => classify(f.path) === SURFACE.NON_CODE)
}

/** High-risk status also derives from every changed path, cells or not. */
export function touchesHighRisk(files) {
  return files.some((f) => {
    const surface = classify(f.path)
    return [...risksFor(f.path, surface)].some((r) => HIGH_RISK.includes(r))
  })
}

export function isHighRisk(cells) {
  return cells.some((c) => c.mandatory)
}

/**
 * One token per pattern element: "*", or a test for one character. A class `[...]` (`[!...]`
 * negates, a `]` right after `[` or `[!` is literal, `a-z` is a range); an unclosed `[` is a literal.
 */
const globTokens = (pattern) => {
  const tokens = []
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === "*") { if (tokens.at(-1) !== "*") tokens.push("*"); continue }
    if (c === "?") { tokens.push(() => true); continue }
    let j = i + 1
    const negate = pattern[j] === "!"
    if (negate) j++
    const start = j
    if (pattern[j] === "]") j++
    while (j < pattern.length && pattern[j] !== "]") j++
    if (c !== "[" || j >= pattern.length) { tokens.push((x) => x === c); continue }
    const body = pattern.slice(start, j)
    tokens.push((x) => {
      let hit = false
      for (let k = 0; k < body.length; k++) {
        if (body[k + 1] === "-" && k + 2 < body.length) {
          if (x >= body[k] && x <= body[k + 2]) hit = true
          k += 2
        } else if (body[k] === x) hit = true
      }
      return hit !== negate
    })
    i = j
  }
  return tokens
}

/**
 * Python fnmatch semantics: whole-string match, `*` crosses directory separators. Iterative
 * two-pointer matching with one star backtrack point: O(name × pattern), no regex.
 */
export function fnmatch(name, pattern) {
  const tokens = globTokens(pattern)
  let n = 0
  let t = 0
  let starT = -1
  let starN = 0
  while (n < name.length) {
    if (tokens[t] === "*") {
      starT = ++t
      starN = n
    } else if (t < tokens.length && tokens[t](name[n])) {
      t++
      n++
    } else if (starT >= 0) {
      t = starT
      n = ++starN
    } else {
      return false
    }
  }
  while (tokens[t] === "*") t++
  return t === tokens.length
}

/**
 * Bounded parser for the one documented instruction shape:
 *   instructions:
 *     - name: <scalar>
 *       instructions: <scalar or block scalar>
 *       fileFilters:
 *         - <glob>
 * Deliberately not a general YAML implementation — anything it does not recognise is ignored
 * rather than guessed at, and it never evaluates or executes anything.
 */
export function parseInstructionsYaml(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n")
  const items = []
  // Only items under a top-level `instructions:` key are recognised. Without this, a `- name:`
  // block nested under any unrelated key was picked up as policy.
  let inRoot = false
  let itemIndent = null
  let blockedIndent = null
  let current = null
  let blockKey = null
  let blockFolded = false
  let blockIndent = 0
  let blockLines = null
  let inFilters = false

  const flushBlock = () => {
    if (blockKey && current) {
      // `>` folds lines into paragraphs; `|` keeps them literal.
      const text = blockFolded
        ? blockLines.join("\n").split(/\n{2,}/).map((para) => para.split("\n").join(" ").trim()).join("\n\n")
        : blockLines.join("\n")
      current[blockKey] = text.trimEnd()
    }
    blockKey = null
    blockFolded = false
    blockLines = null
  }
  const flushItem = () => {
    flushBlock()
    if (current && !current.malformed && current.name && current.instructions && current.fileFilters.length) items.push(current)
    current = null
    inFilters = false
  }

  for (const raw of lines) {
    if (blockKey) {
      if (raw.trim() === "" ) { blockLines.push(""); continue }
      const indent = raw.length - raw.trimStart().length
      if (indent >= blockIndent) { blockLines.push(raw.slice(blockIndent)); continue }
      flushBlock()
    }
    const line = raw.replace(/\s+$/, "")
    if (!line.trim() || /^\s*#/.test(line)) continue

    if (/^instructions:\s*$/.test(line)) { flushItem(); inRoot = true; itemIndent = null; blockedIndent = null; continue }
    if (/^\S/.test(line) && !/^instructions:/.test(line)) { flushItem(); inRoot = false; continue }
    if (!inRoot) continue

    // A bare `key:` under the root opens a nested mapping. Anything indented beneath it is not
    // an instruction item, however well-formed it looks.
    const nestedKey = line.match(/^(\s+)([A-Za-z0-9_-]+):\s*$/)
    if (nestedKey && !current) {
      blockedIndent = nestedKey[1].length
      continue
    }

    const itemStart = line.match(/^(\s*)-\s+name:\s*(.*)$/)
    if (itemStart) {
      const indent = itemStart[1].length
      if (blockedIndent !== null) {
        if (indent > blockedIndent) { flushItem(); continue } // smuggled under a nested key
        blockedIndent = null
      }
      if (itemIndent === null) itemIndent = indent
      if (indent !== itemIndent) { flushItem(); continue } // not the root list
      flushItem()
      const name = unquote(itemStart[2])
      current = { name, instructions: "", fileFilters: [], malformed: name == null }
      continue
    }
    if (!current) continue

    const filtersKey = line.match(/^\s*fileFilters:\s*(.*)$/)
    if (filtersKey) {
      inFilters = true
      const inline = filtersKey[1].trim()
      if (inline) {
        // Only a well-formed inline array is accepted; anything else is unsupported input and is
        // rejected outright rather than half-parsed into a policy that was never written.
        if (/^\[.*\]$/.test(inline)) {
          const entries = inline.slice(1, -1).split(",").map((x) => unquote(x.trim()))
          if (entries.some((x) => x == null)) current.malformed = true
          current.fileFilters = entries.filter(Boolean)
        } else {
          current.malformed = true
        }
        inFilters = false
      }
      continue
    }
    const listItem = line.match(/^\s*-\s+(.*)$/)
    if (listItem && inFilters) {
      const entry = unquote(listItem[1])
      if (entry == null) current.malformed = true
      else current.fileFilters.push(entry)
      continue
    }

    const kv = line.match(/^\s*(name|instructions):\s*(.*)$/)
    if (kv) {
      inFilters = false
      const [, key, value] = kv
      const v = value.trim()
      if (v === "|" || v === ">" || v === "|-" || v === ">-") {
        blockKey = key
        blockFolded = v.startsWith(">")
        blockLines = []
        blockIndent = (raw.length - raw.trimStart().length) + 2
      } else {
        const scalar = unquote(v)
        if (scalar == null) current.malformed = true
        else current[key] = scalar
      }
    }
  }
  flushItem()
  return items
}

const YAML_NON_STRING = /^(\[|\{|[&*!]|~$|null$|true$|false$|Null$|NULL$|True$|TRUE$|False$|FALSE$)/

/** Unquote a plain YAML scalar; anything that is not one returns null so the item is dropped. */
const unquote = (value) => {
  if (typeof value !== "string") return null
  const text = value.trim()
  const quoted = text.match(/^"(.*)"$|^'(.*)'$/)
  if (quoted) return (quoted[1] ?? quoted[2]).trim()
  if (!text || YAML_NON_STRING.test(text)) return null
  return text
}

/**
 * Custom instructions are untrusted advisory input. They are reduced to name + text + globs and
 * carry no authority: nothing here can relax read-only, budgets, admission, stopping or
 * escalation rules, because none of those are expressed as instruction fields.
 */
export function loadInstructionFile(file, kind, text = null) {
  const out = []
  let raw = text
  if (raw == null) {
    if (!existsSync(file)) return out
    try { raw = readFileSync(file, "utf8") } catch { return out }
  }
  let parsed = []
  if (kind === "json") {
    try {
      const data = JSON.parse(raw)
      parsed = Array.isArray(data?.instructions) ? data.instructions : []
    } catch { parsed = [] }
  } else {
    parsed = parseInstructionsYaml(raw)
  }
  for (const item of parsed) {
    // Untrusted advisory input: accept only primitive strings, never coerce arbitrary values.
    if (typeof item?.name !== "string" || typeof item?.instructions !== "string") continue
    const filters = Array.isArray(item.fileFilters)
      ? item.fileFilters.filter((f) => typeof f === "string" && f.trim())
      : []
    if (!item.name.trim() || !item.instructions.trim() || !filters.length) continue
    out.push({
      name: item.name,
      text: item.instructions,
      include: filters.filter((f) => !f.startsWith("!")),
      exclude: filters.filter((f) => f.startsWith("!")).map((f) => f.slice(1)),
      source: kind,
    })
  }
  return out
}

/**
 * Check before read: lstat every component of `rel` under `repo`. Returns null when it is safe
 * to read, "absent" when a component does not exist, or the rejection reason. Never throws, and
 * never opens anything, so a FIFO or a symlinked ancestor cannot be read through.
 */
export function checkSourcePath(repo, rel, last = "file") {
  const parts = rel.split("/")
  for (let i = 0; i < parts.length; i++) {
    let stat
    try {
      stat = lstatSync(join(repo, ...parts.slice(0, i + 1)))
    } catch (error) {
      if (error.code === "ENOENT") return "absent"
      return error.code === "ENOTDIR" ? "not a directory" : String(error.code ?? error.message)
    }
    if (stat.isSymbolicLink()) return "symlink"
    const isLast = i === parts.length - 1
    if (isLast && last === "file" && !stat.isFile()) return "not a regular file"
    if ((!isLast || last === "dir") && !stat.isDirectory()) return "not a directory"
  }
  return null
}

/**
 * Whether a repository source is tracked at HEAD: `{ status }` (`ok`, `not committed` or
 * `modified`) or `{ error }`. Fails closed: a spawn failure or an unexpected exit is an error,
 * never "modified" or "not committed". `raw` (the worktree bytes, when there are any) is compared
 * with the HEAD blob, so index flags such as skip-worktree or assume-unchanged cannot hide an edit.
 * `run` is spawnSync's shape, injectable for tests.
 */
export function trackedState(repo, file, raw, run = spawnSync) {
  const git = (args, options = {}) =>
    run("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], ...options })
  const failure = (name, result) =>
    `git check failed (${result.error ? result.error.code ?? result.error.message : `git ${name} exit ${result.status ?? result.signal}`})`
  const listed = git(["ls-tree", "-z", "HEAD", "--", file])
  if (listed.error || listed.status !== 0) return { error: failure("ls-tree", listed) }
  if (!listed.stdout) return { status: "not committed" }
  if (!raw) return { status: "ok" }
  const blob = git(["cat-file", "blob", `HEAD:./${file}`], { encoding: "buffer", maxBuffer: raw.length + 1 })
  // A HEAD blob longer than the worktree bytes overflows the buffer: it differs.
  if (blob.error?.code === "ENOBUFS") return { status: "modified" }
  if (blob.error || blob.status !== 0) return { error: failure("cat-file", blob) }
  return { status: blob.stdout.equals(raw) ? "ok" : "modified" }
}

/** `trackedState` for a lens source: a skip reason, null when it applies; a git failure throws. */
export function trackedSkip(repo, file, raw, run) {
  const state = trackedState(repo, file, raw, run)
  if (state.error) throw new Error(`${state.error}: ${file}`)
  if (state.status === "not committed") return "not committed"
  return state.status === "modified" ? "changed in this diff" : null
}

const LENS_DIMENSIONS = { architecture: "architecture", quality: "quality", impact: "impact", tests: "tests" }
const MAX_FRONT_MATTER_LINES = 50

/** Parse a lens file: `---` front matter (`paths`, `dimension`) and a markdown body. */
export function parseLensFile(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n")
  const close = lines.indexOf("---", 1)
  if (lines[0] !== "---" || close < 0 || close >= MAX_FRONT_MATTER_LINES) return { error: "no front matter" }
  const globs = []
  const ignoredKeys = []
  let dimension = null
  let inPaths = false
  for (const line of lines.slice(1, close)) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    const listItem = line.match(/^\s+-\s*(.*)$/)
    if (listItem) {
      if (!inPaths) continue
      const entry = unquote(listItem[1])
      if (entry == null) return { error: "malformed paths" }
      globs.push(entry)
      continue
    }
    inPaths = false
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!kv) continue
    const key = kv[1]
    const value = kv[2].trim()
    if (key === "paths") {
      if (!value) { inPaths = true; continue }
      if (!/^\[.*\]$/.test(value)) return { error: "malformed paths" }
      const inner = value.slice(1, -1).trim()
      const entries = inner ? inner.split(",").map((x) => unquote(x)) : []
      if (entries.some((x) => x == null)) return { error: "malformed paths" }
      globs.push(...entries)
    } else if (key === "dimension") {
      const raw = unquote(value)
      dimension = Object.hasOwn(LENS_DIMENSIONS, raw) ? LENS_DIMENSIONS[raw] : null
      if (!dimension) return { error: `unknown dimension: ${value}` }
    } else {
      ignoredKeys.push(key)
    }
  }
  if (!globs.length) return { error: "no paths" }
  const body = lines.slice(close + 1).join("\n").trim()
  if (!body) return { error: "empty body" }
  return {
    include: globs.filter((g) => !g.startsWith("!")),
    exclude: globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1)),
    dimension,
    body,
    ignoredKeys,
  }
}

const LENS_DIR = ".consensus-review/lenses"
export const LENS_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
const MAX_LENS_BYTES = 8192

/**
 * Repository lenses, `.consensus-review/lenses/*.md`, each checked before it is read and applied
 * only when tracked and unchanged at HEAD (else `skipped`). A git failure throws.
 */
export function loadLenses(repo, run) {
  const lenses = []
  const rejected = []
  const skipped = []
  const dirProblem = checkSourcePath(repo, LENS_DIR, "dir")
  if (dirProblem === "absent") return { lenses, rejected, skipped }
  if (dirProblem) return { lenses, rejected: [{ file: LENS_DIR, reason: dirProblem }], skipped }
  let entries
  try {
    entries = readdirSync(join(repo, LENS_DIR)).filter((entry) => entry.endsWith(".md")).sort()
  } catch (error) {
    return { lenses, rejected: [{ file: LENS_DIR, reason: String(error.code ?? error.message) }], skipped }
  }
  for (const entry of entries) {
    const file = `${LENS_DIR}/${entry}`
    const name = entry.slice(0, -3)
    if (!LENS_NAME.test(name)) { rejected.push({ file, reason: "invalid name" }); continue }
    const problem = checkSourcePath(repo, file)
    if (problem) { rejected.push({ file, reason: problem }); continue }
    let raw
    try {
      if (statSync(join(repo, file)).size > MAX_LENS_BYTES) { rejected.push({ file, reason: "too large" }); continue }
      raw = readFileSync(join(repo, file))
    } catch (error) {
      rejected.push({ file, reason: String(error.code ?? error.message) })
      continue
    }
    if (raw.length > MAX_LENS_BYTES) { rejected.push({ file, reason: "too large" }); continue }
    const skip = trackedSkip(repo, file, raw, run)
    if (skip) { skipped.push({ name, file, reason: skip }); continue }
    const lens = parseLensFile(raw.toString("utf8"))
    if (lens.error) { rejected.push({ file, reason: lens.error }); continue }
    lenses.push(lensRecord(name, file, "repo", lens))
  }
  return { lenses, rejected, skipped }
}

const lensRecord = (name, file, layer, lens) => ({
  name,
  text: lens.body,
  include: lens.include,
  exclude: lens.exclude,
  source: "lens",
  dimension: lens.dimension,
  file,
  layer,
  ignoredKeys: lens.ignoredKeys,
})

const PLUGIN_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const realOrNull = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}
/** `{ real }`, `{ absent: true }` (ENOENT, ENOTDIR) or `{ error }` (EACCES, ELOOP, ...): only absence is absence. */
const realOrError = (path) => {
  try {
    return { real: realpathSync(path) }
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { absent: true }
    return { error: `${String(error.code ?? error.message)} (${path})` }
  }
}
const isInside = (path, root) => path === root || path.startsWith(`${root}${sep}`)

/** A user-layer path's ownership problem, or null: owned by you or root, and not group- or world-writable. */
const ownerProblem = (st, uid, path) => {
  if (st.uid !== uid && st.uid !== 0) return `not owned by you or root (${path})`
  const writable = st.mode & 0o002 ? "world-writable" : st.mode & 0o020 ? "group-writable" : null
  return writable && `${writable} (${path}); fix with chmod go-w ${path}`
}

/**
 * The user and built-in layers of one kind (`lenses` or `profiles`), highest first: each `{ layer,
 * root, dir, problem, failure }`. `problem` is null when `dir` may be listed, `absent` when there is
 * nothing, else why the whole layer is ignored. The user root is `$XDG_CONFIG_HOME/consensus-review`,
 * else `~/.config/consensus-review`; it and `dir` must resolve outside the reviewed repository (else
 * ignored), be owned by you or root and not be group- or world-writable (no ancestor walk). That
 * ownership `failure` still lists the files, and each one fails with it: a user failure reserves
 * its names instead of falling through to a lower layer. The built-in root
 * `<plugin>/presets` must resolve outside the reviewed repository. `env`, `pluginRoot`, `uid` and
 * `stat` are injectable for tests. Only ENOENT/ENOTDIR is absence: any other error resolving a user
 * path (EACCES, ELOOP, ...) is a `failure`, so it reserves names too; in the built-in layer, a problem.
 */
export function sourceRoots({ repo = null, kind, env = process.env, pluginRoot = PLUGIN_ROOT, uid = process.getuid?.() ?? null, stat = statSync }) {
  const repoReal = repo ? realOrNull(repo) ?? resolve(repo) : null
  const outside = (path) => {
    const { real, absent, error } = realOrError(path)
    if (absent) return { problem: "absent" }
    if (error) return { error }
    if (repoReal && isInside(real, repoReal)) return { problem: `inside the reviewed repository (${path})` }
    return { real }
  }
  const xdg = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : null
  const base = xdg ?? (env.HOME ? join(env.HOME, ".config") : null)
  const userRoot = base && join(base, "consensus-review")
  const user = {
    layer: "user", root: userRoot, dir: userRoot && join(userRoot, kind), problem: null, failure: null, home: env.HOME, uid, stat, repoReal,
  }
  if (uid === null) user.problem = "no user id on this platform"
  else if (!userRoot) user.problem = "no HOME or XDG_CONFIG_HOME"
  for (const path of user.problem ? [] : [user.root, user.dir]) {
    const found = outside(path)
    if (found.error) { user.failure ??= found.error; break }
    if (found.problem) { user.problem = found.problem; break }
    const st = stat(found.real)
    if (!st.isDirectory()) { user.problem = `not a directory (${path})`; break }
    const failure = ownerProblem(st, uid, path)
    if (failure) user.failure ??= failure
  }
  const builtinRoot = join(pluginRoot, "presets")
  const builtin = { layer: "builtin", root: builtinRoot, dir: join(builtinRoot, kind), problem: null, failure: null, stat: statSync, repoReal }
  const found = outside(builtin.dir)
  builtin.problem = found.problem ?? found.error ?? null
  return [user, builtin]
}

/** The sorted `*.md` entries of a usable layer: `{ entries }` or `{ error }`. */
export function layerEntries(layer) {
  if (layer.problem) return { entries: [] }
  try {
    return { entries: readdirSync(layer.dir).filter((entry) => entry.endsWith(".md")).sort() }
  } catch (error) {
    return { error: `${String(error.code ?? error.message)} (${layer.dir})` }
  }
}

/** How a layer file is named in reports: `~/…` for the user layer, `builtin:<kind>/x.md`. */
const layerFileName = (layer, entry) => {
  const path = join(layer.dir, entry)
  if (layer.layer === "builtin") return `builtin:${path.slice(layer.root.length + 1)}`
  return layer.home && isInside(path, layer.home) ? `~${path.slice(layer.home.length)}` : path
}

/**
 * Check, then read, one file of a user or built-in layer: `{ file, raw }` or `{ file, error }`.
 * Symlinks are resolved first; the target must be a regular file outside the reviewed repository,
 * and in the user layer owned by you or root and not group- or world-writable.
 */
export function readLayerFile(layer, entry, maxBytes) {
  const file = layerFileName(layer, entry)
  if (layer.failure) return { file, error: layer.failure }
  const path = join(layer.dir, entry)
  const { real, absent, error } = realOrError(path)
  if (absent) return { file, error: "dangling symlink" }
  if (error) return { file, error }
  if (layer.repoReal && isInside(real, layer.repoReal)) return { file, error: "inside the reviewed repository" }
  let raw
  try {
    const st = layer.stat(real)
    if (!st.isFile()) return { file, error: "not a regular file" }
    const problem = layer.layer === "user" && ownerProblem(st, layer.uid, path)
    if (problem) return { file, error: problem }
    if (st.size > maxBytes) return { file, error: `too large (over ${maxBytes} bytes)` }
    raw = readFileSync(real)
  } catch (error) {
    return { file, error: String(error.code ?? error.message) }
  }
  if (raw.length > maxBytes) return { file, error: `too large (over ${maxBytes} bytes)` }
  return { file, raw }
}

/** The lenses of one user or built-in layer: `{ lenses, rejected }`, each rejection with its name and layer. */
export function loadLayerLenses(layer) {
  const lenses = []
  const rejected = []
  const listed = layerEntries(layer)
  if (listed.error) return { lenses, rejected: [{ name: null, file: layer.dir, layer: layer.layer, reason: listed.error, unlisted: true }] }
  for (const entry of listed.entries) {
    const name = entry.slice(0, -3)
    const read = readLayerFile(layer, entry, MAX_LENS_BYTES)
    const reject = (reason) => rejected.push({ name: LENS_NAME.test(name) ? name : null, file: read.file, layer: layer.layer, reason })
    if (!LENS_NAME.test(name)) { reject("invalid name"); continue }
    if (read.error) { reject(read.error); continue }
    const lens = parseLensFile(read.raw.toString("utf8"))
    if (lens.error) { reject(lens.error); continue }
    lenses.push(lensRecord(name, read.file, layer.layer, lens))
  }
  return { lenses, rejected }
}

const escapeAttr = (value) => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
const escapeBody = (text) => String(text).replace(/<\//g, "<\\/")

/** `<instruction>` elements only, escaped so no body or attribute can close or forge a fence. */
export function renderInstructions(items) {
  const lines = []
  for (const ins of [...items].sort((a, b) => a.name.localeCompare(b.name))) {
    const dimension = ins.dimension ? ` dimension="${escapeAttr(ins.dimension)}"` : ""
    const files = escapeAttr([...ins.files].sort().join(", "))
    lines.push(`<instruction name="${escapeAttr(ins.name)}"${dimension} files="${files}">`)
    lines.push(escapeBody(ins.text.trim()))
    lines.push("</instruction>")
  }
  return lines.join("\n")
}

export function instructionMatches(path, instruction) {
  const included = !instruction.include.length || instruction.include.some((p) => fnmatch(path, p))
  const excluded = instruction.exclude.some((p) => fnmatch(path, p))
  return included && !excluded
}

export function diffHash(diffText) {
  return createHash("sha256").update(String(diffText)).digest("hex").slice(0, 16)
}

/** Original (pre-change) content from the base, capped as in the reference implementation. */
export function originalFiles(repo, files, base) {
  const out = {}
  for (const f of files) {
    if (!f.oldPath || f.newFile) continue
    const content = gitTry(repo, "show", `${base}:${f.oldPath}`)
    if (content == null) continue
    // Normalise once: the prompt renders this exact value, so the bound derived from it and the
    // context the reviewer actually sees cannot disagree about where the file ends.
    const normalised = content.trimEnd()
    if (normalised.split("\n").length > MAX_ORIGINAL_LINES) continue
    out[f.oldPath] = normalised
  }
  return out
}

/**
 * The static prompt prefix. It must be byte-identical across every pass of a run so that the
 * variable negative-space payload is the only thing that differs — see the plan §1.6 and
 * docs/design/loop-review-measurements.md (cross-process caching was refuted, but prefix stability
 * remains a correctness property: passes must review the same context).
 */
export function buildStaticPrefix(ctx) {
  const parts = []
  parts.push("<review_context>")
  parts.push(`<target>${ctx.target}</target>`)
  parts.push(`<diff_hash>${ctx.diffHash}</diff_hash>`)

  const cells = [...ctx.cells].sort((a, b) => a.id.localeCompare(b.id))
  parts.push("<coverage_cells>")
  for (const c of cells) {
    parts.push(`<cell id="${c.id}" mandatory="${c.mandatory}">${[...c.files].sort().join(", ")}</cell>`)
  }
  parts.push("</coverage_cells>")

  parts.push("<git_diffs>")
  for (const f of [...ctx.files].sort((a, b) => String(a.path).localeCompare(String(b.path)))) {
    parts.push(`<file_diff filename="${f.path}"${f.renamed ? ` renamed_from="${f.oldPath}"` : ""}>`)
    parts.push(
      f.binary
        ? "(binary file — not shown)"
        : isMetadataOnly(f)
          ? `(no content change — ${f.renamed ? "renamed" : f.deleted ? "deleted" : "metadata only"})`
          : String(f.diff ?? "").trimEnd()
    )
    parts.push("</file_diff>")
  }
  parts.push("</git_diffs>")

  const originals = Object.keys(ctx.originals).sort()
  if (originals.length) {
    parts.push("<original_files>")
    for (const p of originals) {
      parts.push(`<full_file filename="${p}">`)
      parts.push(ctx.originals[p])
      parts.push("</full_file>")
    }
    parts.push("</original_files>")
  }
  parts.push("</review_context>")
  return parts.join("\n")
}

/**
 * A PR URL, the one shape settings and parseScope both accept: an optional browser tab (`/files`,
 * `/commits`, `/checks`), query and fragment, all dropped from the canonical `ref`. The alphabet
 * stays shell-safe: the target reaches Bash single-quoted.
 */
export const PR_URL = /^(https?):\/\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)(?:\/(?:files|commits|checks))?\/?(?:\?[A-Za-z0-9._=-]*)?(?:#[A-Za-z0-9._=-]*)?$/

/**
 * The scope of a PR target: `{ pr: null }` for empty (uncommitted), `{ pr: N, repo }` for a PR
 * (`repo` is `host/owner/repo` for a URL, `owner/repo` for the `owner/repo#N` shorthand, which takes
 * the origin's host, or null for `#N`/`N`, i.e. this repository; a URL also gives its canonical
 * `ref`, see PR_URL), null for anything else.
 */
export const parseScope = (target) => {
  const scope = String(target ?? "").trim()
  if (!scope) return { pr: null }
  const bare = /^#?(\d+)$/.exec(scope)
  if (bare) return { pr: bare[1], repo: null }
  const ref = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(scope)
  if (ref) return { pr: ref[3], repo: `${ref[1]}/${ref[2]}`.toLowerCase() }
  const url = PR_URL.exec(scope)
  if (url) return { pr: url[5], repo: `${url[2]}/${url[3]}/${url[4]}`.toLowerCase(), ref: `${url[1]}://${url[2]}/${url[3]}/${url[4]}/pull/${url[5]}` }
  return null
}

/** `host/owner/repo` from a remote URL: `https://host/o/r(.git)`, `git@host:o/r(.git)` or `ssh://git@host/o/r`. */
export const originRepo = (url) => {
  const text = String(url).trim().replace(/\/+$/, "").replace(/\.git$/, "")
  const m = /^(?:https?|ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+)$/.exec(text) ??
    /^(?:[^@/]+@)?([^/:]+):([^/]+)\/([^/]+)$/.exec(text)
  return m ? `${m[1]}/${m[2]}/${m[3]}`.toLowerCase() : null
}

/** A branch name `git check-ref-format --branch` accepts, from a shell-safe alphabet and not an option. */
export function isBranchName(raw, run = spawnSync) {
  if (!/^[A-Za-z0-9._/+-]+$/.test(raw) || raw.startsWith("-")) return false
  return run("git", ["check-ref-format", "--branch", raw], { stdio: "ignore" }).status === 0
}

const BIG = 256 * 1024 * 1024
const failed = (cmd, result) => {
  const why = result.error ? result.error.code ?? result.error.message : String(result.stderr ?? "").trim().split("\n")[0] || `exit ${result.status}`
  return `Command failed: ${cmd}: ${why}`
}

/**
 * The PR's diff from a local clone's remote, exact or not at all. Only advertised SHAs are used:
 * `S1` from ls-remote, a fetch that writes no ref, no FETCH_HEAD and no config (objects only), then
 * `S2` from a second ls-remote, which must equal `S1`. The diff takes SHAs, never branch names, so a
 * stale local `<base>` branch cannot change it.
 */
function cloneDiff({ repo, remote, pr, base, run }) {
  const git = (args) => {
    // No credential prompt: a review must fail on a private remote, not hang on a password.
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" }
    const result = run("git", args, { cwd: repo, env, encoding: "utf8", maxBuffer: BIG, stdio: ["ignore", "pipe", "pipe"] })
    if (result.error || result.status !== 0) throw new Error(failed(`git ${args[0]}`, result))
    return result.stdout
  }
  if (git(["rev-parse", "--is-shallow-repository"]).trim() === "true") throw new Error("shallow clone; fetch full history or use gh")
  if (!base) throw new Error("PR mode without gh needs base=<branch> (the branch the PR targets)")
  if (!isBranchName(base, run)) throw new Error(`base=${base}: expected a branch name`)
  const refs = [`refs/pull/${pr}/head`, `refs/heads/${base}`]
  const advertised = () => {
    const shas = new Map(git(["ls-remote", remote, ...refs]).split("\n").filter(Boolean).map((line) => line.split("\t").reverse()))
    return refs.map((ref) => {
      if (!shas.has(ref)) throw new Error(`${ref} not found on remote ${remote}`)
      return shas.get(ref)
    })
  }
  const [headSha, baseSha] = advertised()
  git(["fetch", "--refmap=", "--no-write-fetch-head", "--no-tags", "--no-auto-gc", remote, ...refs])
  const moved = new Error("PR ref moved during fetch; run it again")
  for (const sha of [headSha, baseSha]) {
    if (run("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: repo, stdio: "ignore" }).status !== 0) throw moved
  }
  const [headNow, baseNow] = advertised()
  if (headNow !== headSha || baseNow !== baseSha) throw moved
  const mb = run("git", ["merge-base", baseSha, headSha], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  if (mb.status === 1) throw new Error(`no merge base between ${base} and the PR head`)
  if (mb.error || mb.status !== 0) throw new Error(failed("git merge-base", mb))
  const mergeBase = mb.stdout.trim()
  return { diffText: git(["diff", "-M", mergeBase, headSha]), base: mergeBase, headSha, baseRef: base, mode: "clone" }
}

/** The remote of `repo` whose raw URL names the PR's repository; `#N` means origin. Null when none does. */
function prRemote(repo, scope, run) {
  const rawUrl = (name) => {
    // The raw value: `remote get-url` expands insteadOf, which is the user's routing, not identity.
    const result = run("git", ["config", "--get", `remote.${name}.url`], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    return result.status === 0 ? result.stdout.trim() : null
  }
  if (!scope.repo) return rawUrl("origin") ? "origin" : null
  const listed = run("git", ["remote"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  const names = listed.status === 0 ? listed.stdout.split("\n").filter(Boolean) : []
  const ordered = [...names.filter((name) => name === "origin"), ...names.filter((name) => name !== "origin")]
  const wanted = scope.ref ? scope.repo : `${originRepo(rawUrl("origin") ?? "")?.split("/")[0]}/${scope.repo}`
  return ordered.find((name) => originRepo(rawUrl(name) ?? "") === wanted) ?? null
}

/** The public diff URL for a PR target, on its own host (a URL's, or origin's for `owner/repo#N`). */
function diffUrl(repo, scope, run) {
  if (scope.ref) return `${scope.ref.replace(/\/+$/, "")}.diff`
  if (!scope.repo || !repo) return null
  const origin = run("git", ["config", "--get", "remote.origin.url"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  const host = origin.status === 0 ? originRepo(origin.stdout)?.split("/")[0] : null
  return host ? `https://${host}/${scope.repo}/pull/${scope.pr}.diff` : null
}

/**
 * Resolve a target to a raw diff plus the base it was taken against. A PR comes from `gh`, else from
 * a local clone's matching remote (`base` required), else, for a URL or `owner/repo#N`, from the
 * public diff URL (diff-only). `run` is spawnSync's shape, injectable for tests.
 */
export function resolveTarget({ repo, mode, range, prTarget, workDir, base = null, run = spawnSync }) {
  if (mode === "range") {
    // Honour the right-hand revision: `a..b` must review b, not whatever HEAD happens to be.
    const [lhs, rhs = "HEAD"] = String(range).split("..")
    const base = git(repo, "merge-base", lhs, rhs).trim()
    return { diffText: git(repo, "diff", "-M", `${base}..${rhs}`), base, describe: range }
  }
  if (mode === "pr") {
    // Same target semantics as commands/consensus-review.md §1. Never checks the PR out.
    const gh = run("gh", ["pr", "diff", prTarget], { cwd: repo, encoding: "utf8", maxBuffer: BIG, stdio: ["ignore", "pipe", "pipe"] })
    // An empty PR diff stops: a source that printed nothing must not become "no changes".
    const nonEmpty = (r) => {
      if (!String(r.diffText).trim()) throw new Error(`PR ${prTarget}: the ${r.mode} diff is empty; nothing to review`)
      return r
    }
    if (!gh.error && gh.status === 0) return nonEmpty({ diffText: gh.stdout, base: null, describe: `PR ${prTarget}`, mode: "gh" })
    const scope = parseScope(prTarget)
    const noSource = new Error(`${failed(`gh pr diff ${prTarget}`, gh)}; no local clone or public diff URL for it`)
    if (!scope?.pr) throw noSource
    const remote = repo ? prRemote(repo, scope, run) : null
    if (remote) return nonEmpty({ ...cloneDiff({ repo, remote, pr: scope.pr, base, run }), describe: `PR ${prTarget}` })
    const url = diffUrl(repo, scope, run)
    if (!url || !workDir) throw noSource
    // -q first: no ~/.curlrc, whose `output` would send the diff elsewhere and leave stdout empty.
    const curl = run("curl", ["-q", "-fsSL", url], { cwd: workDir, encoding: "utf8", maxBuffer: BIG, stdio: ["ignore", "pipe", "pipe"] })
    if (curl.error || curl.status !== 0) throw new Error(failed(`curl -q -fsSL ${url}`, curl))
    return nonEmpty({ diffText: curl.stdout, base: null, describe: `PR ${prTarget} (diff-only)`, mode: "curl" })
  }
  // Uncommitted: tracked changes plus untracked files, which `git diff HEAD` alone omits — an
  // entirely new source file would otherwise be reviewed as if it did not exist.
  const tracked = git(repo, "diff", "-M", "HEAD")
  // -z: NUL-delimited and never C-quoted, so filenames containing spaces, tabs, newlines or
  // UTF-8 reach git verbatim instead of being mangled into a path that does not exist.
  const untracked = (gitTry(repo, "ls-files", "-z", "--others", "--exclude-standard") ?? "")
    .split("\0").filter(Boolean)
  // `git diff --no-index` exits 1 precisely when there IS a difference, so its output has to be
  // read off the thrown error; treating a non-zero exit as failure silently dropped every
  // untracked file.
  const extra = untracked
    .map((file) => {
      try {
        return git(repo, "diff", "-M", "--no-index", "--", "/dev/null", file)
      } catch (err) {
        return typeof err?.stdout === "string" ? err.stdout : ""
      }
    })
    .filter(Boolean)
    .join("")
  return { diffText: tracked + extra, base: "HEAD", describe: "uncommitted" }
}

export function buildContext({ repo, target = "uncommitted", diffText, base = "HEAD" }) {
  const all = parseDiff(diffText)
  // Metadata-only sections (a pure rename, a mode change) carry no hunks but are still changes.
  const files = all.filter((f) => f.path && !isGenerated(repo, f.path))
  const paths = files.map((f) => f.path)
  // A diff that had sections but lost all of them means the parser did not understand it; that
  // must not read as "nothing to review".
  const lostSections = all.length > 0 && files.length === 0
  const unresolved = all.filter((f) => !f.path).length

  // Originals are part of the supplied context, so they extend the anchor bound — and this must
  // happen BEFORE deriveCells, which copies each file's bound into its cells.
  const originals = base ? originalFiles(repo, files, base) : {}
  for (const f of files) {
    const original = originals[f.oldPath]
    if (original) f.maxLine = Math.max(f.maxLine ?? 0, original.split("\n").length)
  }

  const cells = deriveCells(files)
  const ctx = {
    target,
    repo,
    files,
    paths,
    cells,
    originals,
    diffHash: diffHash(diffText),
    trivial: isTrivial(files) && !lostSections && unresolved === 0,
    unparsed: lostSections || unresolved > 0
      ? `${unresolved || all.length} diff section(s) could not be resolved to a reviewable file`
      : null,
  }
  ctx.highRisk = isHighRisk(cells) || touchesHighRisk(files)
  ctx.staticPrefix = buildStaticPrefix(ctx)
  return ctx
}
