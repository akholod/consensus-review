#!/usr/bin/env node
// Resolves the /consensus-review arguments against one table of settings, so the arbiter reads
// settings.json instead of interpreting flags in prose.
//
//   resolve --wd <WD> --args-file <file>
//   profile --wd <WD> [--repo <REPO>] [--mode uncommitted]
//   profile-edit --repo <REPO> --args-file <file>
//
// `resolve` splits the file on whitespace, writes <WD>/settings.json atomically and prints it, exit
// 0. A `profile=<name>` token leaves the profile pending: `profile`, run once the diff exists,
// re-resolves <WD>/args.txt with the repository profile .consensus-review/profiles/<name>.md and
// rewrites settings.json. Only a profile tracked and unchanged at HEAD, and outside the diff, is
// applied. Any error prints the message to stderr and exits 2 with settings.json untouched.
// Precedence is flag > profile > default. `profile-edit`, the writer behind /consensus-review:profile,
// lists the profiles (no args), prints one (`<name>`) or writes one (`<name> key=value…`); it never
// commits.

import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import {
  closeSync, existsSync, fchmodSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { LENS_NAME, checkSourcePath, parseDiff } from "../src/loop-review/context.mjs"
import { PI_MODEL_ID } from "./lib/lanes.mjs"

const USAGE = [
  "usage: settings.mjs resolve --wd <WD> --args-file <file>",
  "       settings.mjs profile --wd <WD> [--repo <REPO>] [--mode uncommitted]",
  "       settings.mjs profile-edit --repo <REPO> --args-file <file>",
].join("\n")
const DIMS = ["architecture", "quality", "impact", "tests"]
const TIMEOUT_MIN = 30
const TIMEOUT_MAX = 1800

const enumOf = (...values) => ({ values, expected: `expected ${values.join("|")}` })

export const SETTINGS = {
  depth: { default: "auto", ...enumOf("auto", "minimal", "deep") },
  dims: { default: "tier" },
  sceptic: { default: "strict", ...enumOf("off", "basic", "strict") },
  lang: { default: "en" },
  out: { default: "default" },
  archive: { default: "on", ...enumOf("on", "off") },
  consultant: { default: "auto", ...enumOf("auto", "codex", "pi", "claude-cli") },
  extra: { default: "off", ...enumOf("off", "pi") },
  "pi-model": { default: "auto" },
  timeout: { default: 900 },
}

const SHORTHANDS = {
  deep: ["depth", "deep"],
  minimal: ["depth", "minimal"],
  "no-file": ["out", "none"],
}

const TARGETS = [
  /^#\d+$/,
  /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#\d+$/,
  /^https?:\/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/\d+(\/[A-Za-z0-9._/-]*)?(\?[A-Za-z0-9._=-]*)?(#[A-Za-z0-9._=-]*)?$/,
]
// A token shaped like a target that fails TARGETS stops the run rather than falling back to uncommitted mode.
const TARGET_LIKE = /^https?:\/\/|\/pull\/|^[^=\s]*#\d/

const parseDims = (raw) => {
  if (!raw) return { error: "no dimensions" }
  const items = raw.toLowerCase().split(",")
  if (items.includes("")) return { error: "empty dimension" }
  const relative = items.filter((item) => item[0] === "+" || item[0] === "-")
  if (relative.length && relative.length !== items.length) return { error: "mixes absolute and +/- forms" }
  for (const item of items) {
    const name = relative.length ? item.slice(1) : item
    if (!DIMS.includes(name)) return { error: `unknown dimension ${name} (expected ${DIMS.join("|")})` }
  }
  if (!relative.length) return { value: { set: items } }
  const add = items.filter((item) => item[0] === "+").map((item) => item.slice(1))
  const remove = items.filter((item) => item[0] === "-").map((item) => item.slice(1))
  return { value: { add, remove } }
}

const parseRaw = (key, raw) => {
  const setting = SETTINGS[key]
  if (setting.values) {
    const value = raw.toLowerCase()
    return setting.values.includes(value) ? { value } : { error: setting.expected }
  }
  if (key === "dims") return parseDims(raw)
  if (key === "lang") {
    if (/^[\p{L}\p{M}0-9_-]{1,40}$/u.test(raw)) return { value: raw }
    return { error: "expected a language code or name (letters, digits, - or _)" }
  }
  if (key === "out") {
    if (!/^[A-Za-z0-9._/~+@,-]+$/.test(raw)) return { error: "expected none or a path of letters, digits and ._/~+@,-" }
    const word = raw.toLowerCase()
    return { value: word === "none" || word === "default" ? word : raw }
  }
  if (key === "pi-model") {
    if (raw.toLowerCase() === "auto") return { value: "auto" }
    if (PI_MODEL_ID.test(raw)) return { value: raw }
    return { error: "expected auto or a model id ([A-Za-z0-9._:/@+-], up to 100)" }
  }
  if (!/^[+-]?\d+$/.test(raw)) return { error: "expected an integer" }
  const seconds = Number(raw)
  const value = Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, seconds))
  return value === seconds ? { value } : { value, clamped: true }
}

/** One value of one known key, from a flag or a profile. The error carries no source prefix. */
export function parseValue(key, raw) {
  const result = parseRaw(key, String(raw))
  return result.error ? { error: `${key}=${raw}: ${result.error}` } : result
}

const renderValue = (key, value) => {
  if (key !== "dims" || value === "tier") return String(value)
  if (value.set) return value.set.join(",")
  return [...value.add.map((d) => `+${d}`), ...value.remove.map((d) => `-${d}`)].join(",")
}

const renderLines = (settings, ignored, clamped, profileName) => {
  const parts = Object.entries(settings).map(([key, { value, source }]) => {
    const origin = source === "profile" ? `profile ${profileName}` : source
    const note = clamped.has(key) ? `${origin}, clamped` : origin
    return `${key}=${renderValue(key, value)} (${note})`
  })
  const skipped = ignored.map(({ token, reason }) => `${token} (${reason})`)
  return {
    settings: `Settings: ${parts.join(" | ")}`,
    ignored: `Ignored args: ${skipped.length ? skipped.join(", ") : "none"}`,
  }
}

/** A profile's raw values as parsed settings, or `{ error }` without the `profile <name>: ` prefix. */
const parseProfileValues = (values) => {
  const parsed = []
  for (const [rawKey, raw] of Object.entries(values)) {
    const key = rawKey.toLowerCase()
    if (key === "target" || key === "profile") return { error: `${key} is not a profile key` }
    if (!SETTINGS[key]) return { error: `unknown key ${rawKey}` }
    const result = parseValue(key, raw)
    if (result.error) return { error: result.error }
    parsed.push({ key, value: result.value, clamped: Boolean(result.clamped) })
  }
  return { parsed }
}

const nameError = (raw) => `profile=${raw}: expected a profile name ([a-z0-9][a-z0-9_-], up to 64)`

/**
 * Tokens are the whitespace-split arguments; `profile` is the loaded layer `{ name, file, values:
 * { key: raw } }` or null. Returns the resolved object or `{ error }`. The last token for a key
 * wins. A `profile=<name>` token without a layer returns the profile as pending.
 */
export function resolveSettings(tokens, { profile = null } = {}) {
  const settings = {}
  for (const [key, { default: value }] of Object.entries(SETTINGS)) settings[key] = { value, source: "default" }
  const clamped = new Set()

  if (profile) {
    const layer = parseProfileValues(profile.values)
    if (layer.error) return { error: `profile ${profile.name}: ${layer.error}` }
    for (const { key, value, clamped: isClamped } of layer.parsed) {
      settings[key] = { value, source: "profile" }
      if (isClamped) clamped.add(key)
    }
  }

  let target = { kind: "uncommitted", ref: null }
  let targetToken = null
  let profileName = null
  const tokenOf = {}
  const ignored = []
  for (const token of tokens) {
    const word = token.startsWith("--") ? token.slice(2) : token
    if (TARGETS.some((re) => re.test(word))) {
      if (targetToken) ignored.push({ token: targetToken, reason: `overridden by ${token}` })
      target = { kind: "pr", ref: word }
      targetToken = token
      continue
    }
    if (TARGET_LIKE.test(word)) return { error: `${token}: not a valid PR target (letters, digits and ._-/#=? only)` }
    const eq = word.indexOf("=")
    let key = null
    let raw = null
    if (eq > 0) {
      key = word.slice(0, eq).toLowerCase()
      raw = word.slice(eq + 1)
    } else if (SHORTHANDS[word.toLowerCase()]) {
      [key, raw] = SHORTHANDS[word.toLowerCase()]
    }
    if (key === "profile") {
      if (!LENS_NAME.test(raw)) return { error: nameError(raw) }
      if (tokenOf.profile) ignored.push({ token: tokenOf.profile, reason: `overridden by ${token}` })
      tokenOf.profile = token
      profileName = raw
      continue
    }
    if (!SETTINGS[key]) {
      ignored.push({ token, reason: "unknown" })
      continue
    }
    const result = parseValue(key, raw)
    if (result.error) return { error: result.error }
    if (tokenOf[key]) ignored.push({ token: tokenOf[key], reason: `overridden by ${token}` })
    tokenOf[key] = token
    settings[key] = { value: result.value, source: "flag" }
    if (result.clamped) clamped.add(key)
    else clamped.delete(key)
  }

  const noPiLane = ["codex", "claude-cli"].includes(settings.consultant.value) && settings.extra.value === "off"
  if (noPiLane && settings["pi-model"].source === "flag") {
    ignored.push({ token: tokenOf["pi-model"], reason: "no pi lane" })
    settings["pi-model"] = { value: SETTINGS["pi-model"].default, source: "default" }
  }

  const lines = renderLines(settings, ignored, clamped, profile?.name)
  if (profile) return { schema: 1, target, settings, ignored, profile: { name: profile.name, file: profile.file ?? null }, lines }
  if (!profileName) return { schema: 1, target, settings, ignored, profile: null, lines }
  lines.settings = `Settings: profile ${profileName} NOT APPLIED (pending)`
  return { schema: 1, target, settings, ignored, profile: { name: profileName, pending: true }, lines }
}

const PROFILE_PARENT = ".consensus-review"
const PROFILE_DIR = ".consensus-review/profiles"
const MAX_PROFILE_BYTES = 4096
const MAX_FRONT_MATTER_LINES = 50

/** `---` front matter of `key: value` lines, blank lines and `#` comments; the body is ignored. */
export function parseProfileFile(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n")
  const close = lines.indexOf("---", 1)
  if (lines[0] !== "---" || close < 0 || close >= MAX_FRONT_MATTER_LINES) return { error: "no front matter" }
  const values = {}
  const seen = new Set()
  for (let i = 1; i < close; i++) {
    const line = lines[i]
    if (!line.trim() || /^\s*#/.test(line)) continue
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!kv) return { error: `malformed line ${i + 1}` }
    const key = kv[1]
    const value = kv[2].trim()
    if (seen.has(key.toLowerCase())) return { error: `duplicate key ${key}` }
    if (!value) return { error: `empty value for ${key}` }
    seen.add(key.toLowerCase())
    values[key] = value
  }
  return { values }
}

/** Fails closed: a spawn failure or an unexpected exit is an error, never "modified" or "untracked". */
const gitState = (repo, file) => {
  const run = (args) => spawnSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  const failure = (name, result) =>
    `git check failed (${result.error ? result.error.code ?? result.error.message : `git ${name} exit ${result.status ?? result.signal}`})`
  const diff = run(["diff", "--quiet", "--no-ext-diff", "HEAD", "--", file])
  if (diff.error || (diff.status !== 0 && diff.status !== 1)) return { error: failure("diff", diff) }
  if (diff.status === 1) return { status: "modified" }
  const listed = run(["ls-files", "-z", "--", file])
  if (listed.error || listed.status !== 0) return { error: failure("ls-files", listed) }
  return { status: listed.stdout ? "ok" : "not committed" }
}

const readProfile = (repo, file) => {
  let raw
  try {
    if (statSync(join(repo, file)).size > MAX_PROFILE_BYTES) return { error: `too large (over ${MAX_PROFILE_BYTES} bytes)` }
    raw = readFileSync(join(repo, file))
  } catch (error) {
    return { error: String(error.code ?? error.message) }
  }
  if (raw.length > MAX_PROFILE_BYTES) return { error: `too large (over ${MAX_PROFILE_BYTES} bytes)` }
  return { ...parseProfileFile(raw.toString("utf8")), raw }
}

/** D15 on both directories, then one readdir: `{ entries }` (sorted `*.md`), `{ absent }` or `{ error }`. */
const readProfileDir = (repo) => {
  for (const dir of [PROFILE_PARENT, PROFILE_DIR]) {
    const problem = checkSourcePath(repo, dir, "dir")
    if (problem === "absent") return { absent: true }
    if (problem) return { error: `${problem} (${dir})` }
  }
  try {
    return { entries: readdirSync(join(repo, PROFILE_DIR)).filter((entry) => entry.endsWith(".md")).sort() }
  } catch (error) {
    return { error: `${String(error.code ?? error.message)} (${PROFILE_DIR})` }
  }
}

const profileNames = (entries) => entries.map((entry) => entry.slice(0, -3)).filter((name) => LENS_NAME.test(name))

/**
 * The profile a run names, or `{ error }` with the literal stop message. `changed` is the diff's
 * path/oldPath set. Applied only when tracked, unchanged against HEAD and outside the diff.
 */
export function loadProfile({ repo, name, changed = [] }) {
  if (!LENS_NAME.test(name)) return { error: nameError(name) }
  const fail = (reason) => ({ error: `profile ${name}: ${reason}` })
  const notFound = (names) => ({ error: `profile=${name}: no such profile (available: ${names.length ? names.join(", ") : "none"})` })
  const dir = readProfileDir(repo)
  if (dir.absent) return notFound([])
  if (dir.error) return fail(dir.error)
  // The exact readdir entry, so a case-insensitive filesystem never answers for another spelling.
  if (!dir.entries.includes(`${name}.md`)) return notFound(profileNames(dir.entries))
  const file = `${PROFILE_DIR}/${name}.md`
  const problem = checkSourcePath(repo, file)
  if (problem) return fail(`${problem} (${file})`)
  const changedMessage = fail(`changed in this diff (${file}); commit it first or pass its settings as flags`)
  if (changed.includes(file)) return changedMessage
  const git = gitState(repo, file)
  if (git.error) return fail(git.error)
  if (git.status === "modified") return changedMessage
  if (git.status === "not committed") return fail(`not tracked (${file}); commit it first or pass its settings as flags`)
  const parsed = readProfile(repo, file)
  if (parsed.error) return fail(parsed.error)
  return { name, file, values: parsed.values }
}

/**
 * Every `*.md` in the profiles directory, for doctor and the profile listing:
 * `{ name, file, values, status, error }`. `status` is `ok`, `not committed` or `modified` (there is
 * no diff here); `error` (D15, git, size, format or a value, unprefixed) is null when it loads.
 * A directory problem is one entry with `name: null`.
 */
export function listProfiles(repo) {
  const dir = readProfileDir(repo)
  if (dir.absent) return []
  if (dir.error) return [{ name: null, file: PROFILE_DIR, values: null, status: null, error: dir.error }]
  return dir.entries.map((entry) => {
    const name = entry.slice(0, -3)
    const file = `${PROFILE_DIR}/${entry}`
    const result = (status, error, values = null) => ({ name, file, values, status, error })
    if (!LENS_NAME.test(name)) return result(null, "invalid name")
    const problem = checkSourcePath(repo, file)
    if (problem) return result(null, `${problem} (${file})`)
    const git = gitState(repo, file)
    if (git.error) return result(null, git.error)
    const parsed = readProfile(repo, file)
    if (parsed.error) return result(git.status, parsed.error)
    const checked = parseProfileValues(parsed.values)
    return result(git.status, checked.error ?? null, parsed.values)
  })
}

const writeSettings = (wd, resolved) => {
  const text = `${JSON.stringify(resolved, null, 2)}\n`
  const path = join(wd, "settings.json")
  writeFileSync(`${path}.tmp`, text)
  renameSync(`${path}.tmp`, path)
  return text
}

const readTokens = (file) => readFileSync(file, "utf8").split(/\s+/).filter(Boolean)

const fail = (message) => {
  process.stderr.write(`${message}\n`)
  return 2
}

const applyProfile = ({ wd, repo, mode }) => {
  const argsFile = join(wd, "args.txt")
  const diffFile = join(wd, "diff.patch")
  if ((mode && mode !== "uncommitted") || !existsSync(argsFile)) return fail(USAGE)
  const tokens = readTokens(argsFile)
  const pending = resolveSettings(tokens)
  if (pending.error) return fail(pending.error)
  if (!pending.profile) return fail("no profile=<name> in args.txt")
  const { name } = pending.profile
  if (!repo) return fail(`profile=${name}: needs the repository (diff-only mode)`)
  if (!existsSync(diffFile)) return fail(USAGE)
  const changed = parseDiff(readFileSync(diffFile, "utf8")).flatMap((s) => [s.path, s.oldPath]).filter(Boolean)
  const profile = loadProfile({ repo, name, changed })
  if (profile.error) return fail(profile.error)
  const resolved = resolveSettings(tokens, { profile })
  if (resolved.error) return fail(resolved.error)
  process.stdout.write(writeSettings(wd, resolved))
  return 0
}

/** `[key, rendered]` pairs of a parsed-values Map, in SETTINGS order. */
const orderedPairs = (values) =>
  Object.keys(SETTINGS).filter((key) => values.has(key)).map((key) => [key, renderValue(key, values.get(key))])

/** The raw bytes after the closing `---` line (CRLF kept), and whether the front matter had comments. */
const splitFrontMatter = (raw) => {
  const text = raw.toString("latin1")
  const lineRe = /([^\r\n]*)(\r\n|\r|\n|$)/y
  let offset = 0
  let index = 0
  let hasComments = false
  while (offset < text.length) {
    lineRe.lastIndex = offset
    const line = lineRe.exec(text)[1]
    offset = lineRe.lastIndex
    if (index > 0 && line === "---") return { body: raw.subarray(offset), hasComments }
    if (index > 0 && /^\s*#/.test(line)) hasComments = true
    index++
  }
  return { body: Buffer.alloc(0), hasComments }
}

const listProfileLines = (repo) => {
  const defaults = Object.entries(SETTINGS).map(([key, { default: value }]) => `${key}=${value}`)
  const lines = [`defaults (built-in): ${defaults.join(" | ")}`]
  const entries = listProfiles(repo)
  if (!entries.length) lines.push(`no profiles in ${PROFILE_DIR}/`)
  for (const entry of entries) {
    const label = entry.name ?? entry.file
    if (entry.error) {
      lines.push(`${label}: invalid (${entry.error})`)
      continue
    }
    const values = new Map(parseProfileValues(entry.values).parsed.map(({ key, value }) => [key, value]))
    const pairs = orderedPairs(values).map(([key, value]) => `${key}=${value}`)
    lines.push(`${label}: ${pairs.length ? pairs.join(" ") : "(no keys)"}`)
  }
  process.stdout.write(`${lines.join("\n")}\n`)
  return 0
}

/** `key=value` tokens as `{ key, value }` (null removes the key), or `{ error }`. */
const parseUpdates = (tokens) => {
  const updates = []
  for (const token of tokens) {
    const eq = token.indexOf("=")
    if (eq <= 0) return { error: `${token}: expected key=value` }
    const rawKey = token.slice(0, eq)
    const raw = token.slice(eq + 1)
    const key = rawKey.toLowerCase()
    if (key === "target" || key === "profile") return { error: `${key} is not a profile key` }
    if (!SETTINGS[key]) return { error: `unknown key ${rawKey}` }
    if (!raw) {
      updates.push({ key, value: null })
      continue
    }
    const result = parseValue(key, raw)
    if (result.error) return { error: result.error }
    updates.push({ key, value: result.value })
  }
  return { updates }
}

/** Writes `content` to `target` through an exclusive temp file in the same directory, then renames it. */
const replaceFile = (dir, name, target, content, mode) => {
  const tmp = join(dir, `.${name}.md.${randomBytes(6).toString("hex")}.tmp`)
  let fd = null
  let created = false
  try {
    fd = openSync(tmp, "wx", 0o644)
    created = true
    writeFileSync(fd, content)
    if (mode !== null) fchmodSync(fd, mode)
    closeSync(fd)
    fd = null
    renameSync(tmp, target)
    return null
  } catch (error) {
    if (fd !== null) closeSync(fd)
    if (created) rmSync(tmp, { force: true })
    return String(error.code ?? error.message)
  }
}

/** /consensus-review:profile: list (no args), print (`<name>`) or write (`<name> key=value…`). Never commits. */
const editProfile = ({ repo, argsFile }) => {
  const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  if (inside.error || inside.status !== 0) return fail(`not a git repository (${repo})`)
  const tokens = readTokens(argsFile)
  if (!tokens.length) return listProfileLines(repo)
  const name = tokens[0]
  if (!LENS_NAME.test(name)) return fail(nameError(name))
  const parsedUpdates = parseUpdates(tokens.slice(1))
  if (parsedUpdates.error) return fail(parsedUpdates.error)
  const { updates } = parsedUpdates
  const prefix = `profile ${name}: `
  const file = `${PROFILE_DIR}/${name}.md`
  const levels = [[PROFILE_PARENT, "dir"], [PROFILE_DIR, "dir"], [file, "file"]]
  let missing = null
  for (const [path, kind] of levels) {
    const problem = checkSourcePath(repo, path, kind)
    if (problem === "absent") {
      missing = path
      break
    }
    if (problem) return fail(`${prefix}${problem} (${path})`)
  }
  const exists = missing === null
  const target = join(repo, file)

  if (!updates.length) {
    if (!exists) return fail(`${prefix}nothing to write (give key=value)`)
    const shown = readProfile(repo, file)
    if (!shown.raw) return fail(`${prefix}${shown.error}`)
    process.stdout.write(shown.raw)
    return 0
  }

  const values = new Map()
  let body = Buffer.alloc(0)
  let hasComments = false
  let mode = null
  if (exists) {
    const current = readProfile(repo, file)
    const checked = current.error ? current : parseProfileValues(current.values)
    if (checked.error) return fail(`${prefix}${checked.error}; fix or delete the file`)
    for (const { key, value } of checked.parsed) values.set(key, value)
    const split = splitFrontMatter(current.raw)
    body = split.body
    hasComments = split.hasComments
    mode = statSync(target).mode & 0o777
  }
  for (const { key, value } of updates) {
    if (value === null) values.delete(key)
    else values.set(key, value)
  }
  const front = orderedPairs(values).map(([key, value]) => `${key}: ${value}\n`).join("")
  const content = Buffer.concat([Buffer.from(`---\n${front}---\n`), body])
  if (content.length > MAX_PROFILE_BYTES) return fail(`${prefix}too large (over ${MAX_PROFILE_BYTES} bytes)`)

  const dirs = [PROFILE_PARENT, PROFILE_DIR]
  const first = dirs.indexOf(missing)
  try {
    if (first >= 0) for (const dir of dirs.slice(first)) mkdirSync(join(repo, dir))
  } catch (error) {
    return fail(`${prefix}cannot create the directory (${String(error.code ?? error.message)})`)
  }
  const writeError = replaceFile(join(repo, PROFILE_DIR), name, target, content, mode)
  if (writeError) return fail(`${prefix}write failed (${writeError})`)

  const verb = exists ? "Update" : "Add"
  const text = content.toString("utf8")
  const out = [`${exists ? "Updated" : "Created"} ${file}:`, text.endsWith("\n") ? text.slice(0, -1) : text]
  if (hasComments) out.push("The comments in the front matter were dropped.")
  out.push(`Not applied until committed: git add -- ${file} && git commit -m '${verb} review profile ${name}' -- ${file}`)
  process.stdout.write(`${out.join("\n")}\n`)
  return 0
}

export function main(argv) {
  let values
  let positionals
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: {
        wd: { type: "string" }, "args-file": { type: "string" }, repo: { type: "string" }, mode: { type: "string" },
      },
      allowPositionals: true,
    }))
  } catch (error) {
    process.stderr.write(`${USAGE}\n${error.message}\n`)
    return 2
  }
  if (positionals.length !== 1) return fail(USAGE)
  const file = values["args-file"]
  if (positionals[0] === "profile-edit") {
    if (!values.repo || !existsSync(values.repo) || !file || !existsSync(file)) return fail(USAGE)
    return editProfile({ repo: values.repo, argsFile: file })
  }
  if (!values.wd || !existsSync(values.wd)) return fail(USAGE)
  if (positionals[0] === "profile") return applyProfile({ wd: values.wd, repo: values.repo ?? null, mode: values.mode ?? null })
  if (positionals[0] !== "resolve" || !file || !existsSync(file)) return fail(USAGE)
  const resolved = resolveSettings(readTokens(file))
  if (resolved.error) return fail(resolved.error)
  process.stdout.write(writeSettings(values.wd, resolved))
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
