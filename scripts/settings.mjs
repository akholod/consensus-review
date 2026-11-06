#!/usr/bin/env node
// Resolves the /consensus-review arguments against one table of settings, so the arbiter reads
// settings.json instead of interpreting flags in prose.
//
//   resolve --wd <WD> --args-file <file>
//   profile --wd <WD> [--repo <REPO>] [--mode uncommitted]
//   profile-edit --repo <REPO> --args-file <file>
//   init --repo <REPO> --args-file <file>
//
// `resolve` splits the file on whitespace, writes <WD>/settings.json atomically and prints it, exit
// 0. A `profile=<name>` token leaves the profile pending: `profile`, run once the diff exists,
// re-resolves <WD>/args.txt with the profile <name> (user, else .consensus-review/profiles/<name>.md,
// else built-in) and rewrites settings.json. A repository profile is applied only when tracked and
// unchanged at HEAD, and outside the diff. Any error prints the message to stderr and exits 2 with settings.json untouched.
// Precedence is flag > profile > default. `profile-edit`, the writer behind /consensus-review:profile,
// lists the profiles (no args), prints one (`<name>`) or writes one (`<name> key=value…`); it never
// commits. `init`, the writer behind /consensus-review:init-lenses, copies the built-in lenses and
// profiles (all, or the names given) into .consensus-review/; it never overwrites and never commits.

import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import {
  closeSync, existsSync, fchmodSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync,
  statSync, writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import {
  LENS_NAME, checkSourcePath, isBranchName, layerEntries, parseDiff, readLayerFile, sourceRoots, trackedState,
} from "../src/loop-review/context.mjs"
import { PI_MODEL_ID } from "./lib/lanes.mjs"

const USAGE = [
  "usage: settings.mjs resolve --wd <WD> --args-file <file>",
  "       settings.mjs profile --wd <WD> [--repo <REPO>] [--mode uncommitted]",
  "       settings.mjs profile-edit --repo <REPO> --args-file <file>",
  "       settings.mjs init --repo <REPO> --args-file <file>",
].join("\n")
const DIMS = ["architecture", "quality", "impact", "tests"]
const TIMEOUT_MIN = 30
const TIMEOUT_MAX = 1800

const enumOf = (...values) => ({ values, expected: `expected ${values.join("|")}` })

export const SETTINGS = {
  depth: { default: "auto", ...enumOf("auto", "minimal", "deep") },
  dims: { default: "tier" },
  lenses: { default: "auto" },
  sceptic: { default: "strict", ...enumOf("off", "basic", "strict") },
  lang: { default: "en" },
  out: { default: "default" },
  archive: { default: "on", ...enumOf("on", "off") },
  consultant: { default: "auto", ...enumOf("auto", "codex", "pi", "claude-cli") },
  extra: { default: "off", ...enumOf("off", "pi") },
  "pi-model": { default: "auto" },
  timeout: { default: 900 },
  models: { default: "agent" },
  effort: { default: "agent" },
  base: { default: null },
}

const ROLES = ["architecture", "impact", "quality", "tests", "verifier"]
const ROLE_VALUES = {
  models: { noun: "model", values: ["opus", "sonnet", "haiku", "fable"] },
  effort: { noun: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
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

/** `a,b` as `{ set }` or `+a,-b` as `{ add, remove }`; `check(name)` returns an error or null. */
const parseList = (items, noun, check) => {
  if (items.includes("")) return { error: `empty ${noun}` }
  const relative = items.filter((item) => item[0] === "+" || item[0] === "-")
  if (relative.length && relative.length !== items.length) return { error: "mixes absolute and +/- forms" }
  for (const item of items) {
    const problem = check(relative.length ? item.slice(1) : item)
    if (problem) return { error: problem }
  }
  if (!relative.length) return { value: { set: items } }
  const add = items.filter((item) => item[0] === "+").map((item) => item.slice(1))
  const remove = items.filter((item) => item[0] === "-").map((item) => item.slice(1))
  return { value: { add, remove } }
}

const parseDims = (raw) => {
  if (!raw) return { error: "no dimensions" }
  return parseList(raw.toLowerCase().split(","), "dimension",
    (name) => (DIMS.includes(name) ? null : `unknown dimension ${name} (expected ${DIMS.join("|")})`))
}

/** `auto`, `none`, or lens names in the dims grammar. Names keep their case: LENS_NAME is lower-case. */
const parseLenses = (raw) => {
  const word = raw.toLowerCase()
  if (word === "auto" || word === "none") return { value: word }
  if (!raw) return { error: "expected auto, none or lens names" }
  return parseList(raw.split(","), "lens name",
    (name) => (LENS_NAME.test(name) ? null : `invalid lens name ${name} ([a-z0-9][a-z0-9_-], up to 64)`))
}

/** `agent`, or `role:value` items joined by `,`, as an object in ROLES order. */
const parseRoleMap = (raw, { noun, values }) => {
  if (raw.toLowerCase() === "agent") return { value: "agent" }
  if (!raw) return { error: `expected agent or role:${noun} items` }
  const map = {}
  for (const item of raw.toLowerCase().split(",")) {
    if (!item) return { error: "empty item" }
    const parts = item.split(":")
    if (parts.length !== 2) return { error: `item ${item} is not role:${noun}` }
    const role = parts[0]
    const value = parts[1]
    if (!ROLES.includes(role)) return { error: `unknown role ${role} (expected ${ROLES.join("|")})` }
    if (!values.includes(value)) return { error: `unknown ${noun} ${value} (expected ${values.join("|")})` }
    if (map[role]) return { error: `duplicate role ${role}` }
    map[role] = value
  }
  const ordered = {}
  for (const role of ROLES) if (map[role]) ordered[role] = map[role]
  return { value: ordered }
}

const parseRaw = (key, raw) => {
  const setting = SETTINGS[key]
  if (setting.values) {
    const value = raw.toLowerCase()
    return setting.values.includes(value) ? { value } : { error: setting.expected }
  }
  if (key === "dims") return parseDims(raw)
  if (key === "lenses") return parseLenses(raw)
  if (ROLE_VALUES[key]) return parseRoleMap(raw, ROLE_VALUES[key])
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
  if (key === "base") return isBranchName(raw) ? { value: raw } : { error: "expected a branch name" }
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
  if (ROLE_VALUES[key] && value !== "agent") return Object.entries(value).map(([role, v]) => `${role}:${v}`).join(",")
  if ((key !== "dims" && key !== "lenses") || typeof value === "string") return String(value)
  if (value.set) return value.set.join(",")
  return [...value.add.map((d) => `+${d}`), ...value.remove.map((d) => `-${d}`)].join(",")
}

const renderLines = (settings, ignored, clamped, profile) => {
  // An unset `base` has no default to show.
  const parts = Object.entries(settings).filter(([, { value }]) => value !== null).map(([key, { value, source }]) => {
    const layer = profile?.layer && profile.layer !== "repo" ? `, ${profile.layer}` : ""
    const origin = source === "profile" ? `profile ${profile.name}${layer}` : source
    let note = clamped.has(key) ? `${origin}, clamped` : origin
    if (ROLE_VALUES[key] && value !== "agent") note = `${note}, requested`
    return `${key}=${renderValue(key, value)} (${note})`
  })
  const skipped = ignored.map(({ token, reason }) => `${token} (${reason})`)
  return {
    settings: `Settings: ${parts.join(" | ")}`,
    ignored: `Ignored args: ${skipped.length ? skipped.join(", ") : "none"}`,
  }
}

/** The lower-cased settings key a profile may hold, or `{ error }` without the `profile <name>: ` prefix. */
const profileKey = (rawKey) => {
  const key = rawKey.toLowerCase()
  if (key === "target" || key === "profile" || key === "base") return { error: `${key} is not a profile key` }
  if (!Object.hasOwn(SETTINGS, key)) return { error: `unknown key ${rawKey}` }
  return { key }
}

/** A repository profile may only add lenses: the change under review must not remove the reviewer's. */
const REPO_LENSES_ERROR = "lenses may only add (+name) in a repository profile"
const repoLensesProblem = (key, value) =>
  key === "lenses" && (value === "none" || value.set || value.remove?.length) ? REPO_LENSES_ERROR : null

/**
 * A profile's raw values as parsed settings, or `{ error }` without the `profile <name>: ` prefix.
 * Only the repository layer is add-only for `lenses`.
 */
const parseProfileValues = (values, layer = "repo") => {
  const parsed = []
  for (const [rawKey, raw] of Object.entries(values)) {
    const named = profileKey(rawKey)
    if (named.error) return named
    const { key } = named
    const result = parseValue(key, raw)
    if (result.error) return { error: result.error }
    if (layer === "repo" && repoLensesProblem(key, result.value)) return { error: REPO_LENSES_ERROR }
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
    const layer = parseProfileValues(profile.values, profile.layer)
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
    if (!Object.hasOwn(SETTINGS, key)) {
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

  if (settings.base.source === "flag" && target.kind !== "pr") {
    ignored.push({ token: tokenOf.base, reason: "no PR target" })
    settings.base = { value: null, source: "default" }
  }

  const lines = renderLines(settings, ignored, clamped, profile)
  if (profile) {
    return { schema: 1, target, settings, ignored, profile: { name: profile.name, layer: profile.layer ?? "repo", file: profile.file ?? null }, lines }
  }
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
  const entries = []
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
    entries.push([key, value])
  }
  // fromEntries defines own properties, so `__proto__` is a key, not the prototype.
  return { values: Object.fromEntries(entries) }
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

/**
 * One user or built-in profile file: `{ name, file, layer, values }`, or `{ error }` with the
 * unprefixed reason and where it is. The exact readdir entry, so a case-insensitive filesystem never
 * answers for another spelling.
 */
const readLayerProfile = (layer, entry) => {
  const read = readLayerFile(layer, entry, MAX_PROFILE_BYTES)
  const parsed = read.error ? read : parseProfileFile(read.raw.toString("utf8"))
  if (parsed.error) return { error: `${parsed.error} (${layer.layer} ${read.file})` }
  return { name: entry.slice(0, -3), file: read.file, layer: layer.layer, values: parsed.values }
}

/**
 * The profile a run names, or `{ error }` with the literal stop message. `changed` is the diff's
 * path/oldPath set. Layers, high to low: user, repo, built-in. A user or repo file of that name that
 * fails a check stops the run; it never falls through. A repo profile applies only when tracked,
 * unchanged against HEAD and outside the diff. With no `repo` (diff-only), user and built-in only.
 */
export function loadProfile({ repo = null, name, changed = [], run, sources = {} }) {
  if (!LENS_NAME.test(name)) return { error: nameError(name) }
  const fail = (reason) => ({ error: `profile ${name}: ${reason}` })
  const entry = `${name}.md`
  const [user, builtin] = sourceRoots({ ...sources, repo, kind: "profiles" })
  const fromUser = layerEntries(user)
  if (fromUser.error) return fail(`${fromUser.error} (user)`)
  if (fromUser.entries.includes(entry)) {
    const profile = readLayerProfile(user, entry)
    return profile.error ? fail(profile.error) : profile
  }
  const dir = repo ? readProfileDir(repo) : { absent: true }
  if (dir.error) return fail(dir.error)
  if (dir.entries?.includes(entry)) return loadRepoProfile({ repo, name, changed, run })
  const fromBuiltin = layerEntries(builtin)
  if (fromBuiltin.error) return fail(`${fromBuiltin.error} (builtin)`)
  if (fromBuiltin.entries.includes(entry)) {
    const profile = readLayerProfile(builtin, entry)
    return profile.error ? fail(profile.error) : profile
  }
  if (!repo) return { error: `profile=${name}: needs the repository (diff-only mode)` }
  const names = [...new Set([...fromUser.entries, ...(dir.entries ?? []), ...fromBuiltin.entries].map((e) => e.slice(0, -3)))]
    .filter((n) => LENS_NAME.test(n)).sort()
  return { error: `profile=${name}: no such profile (available: ${names.length ? names.join(", ") : "none"})` }
}

/** The repository profile `name`, whose file exists: today's checks, every failure a stop. */
const loadRepoProfile = ({ repo, name, changed, run }) => {
  const fail = (reason) => ({ error: `profile ${name}: ${reason}` })
  const file = `${PROFILE_DIR}/${name}.md`
  const problem = checkSourcePath(repo, file)
  if (problem) return fail(`${problem} (${file})`)
  const changedMessage = fail(`changed in this diff (${file}); commit it first or pass its settings as flags`)
  if (changed.includes(file)) return changedMessage
  const tracked = trackedState(repo, file, undefined, run)
  if (tracked.error) return fail(tracked.error)
  if (tracked.status === "not committed") return fail(`not tracked (${file}); commit it first or pass its settings as flags`)
  const parsed = readProfile(repo, file)
  if (parsed.raw) {
    const git = trackedState(repo, file, parsed.raw, run)
    if (git.error) return fail(git.error)
    if (git.status === "modified") return changedMessage
  }
  if (parsed.error) return fail(parsed.error)
  return { name, file, layer: "repo", values: parsed.values }
}

/**
 * Every profile of every layer, user, repo, then built-in, for doctor and the profile listing:
 * `{ name, file, layer, values, status, error, shadowedBy }`. `status` is `ok`, `not committed` or
 * `modified` (there is no diff here); `error` (D15, git, size, format or a value, unprefixed) is
 * null when it loads; `shadowedBy` names the higher layer holding the same name, else null. A
 * directory problem, or an ignored layer, is one entry with `name: null`.
 */
export function listProfiles(repo, { run, sources = {} } = {}) {
  const [user, builtin] = sourceRoots({ ...sources, repo, kind: "profiles" })
  const fromLayer = (layer) => {
    const listed = layerEntries(layer)
    const problem = listed.error ?? (layer.problem !== "absent" && layer.problem)
    if (problem) return [{ name: null, file: layer.dir, layer: layer.layer, values: null, status: null, error: problem }]
    return listed.entries.map((entry) => {
      const name = entry.slice(0, -3)
      const base = { name, file: null, layer: layer.layer, values: null, status: null }
      if (!LENS_NAME.test(name)) return { ...base, file: entry, error: "invalid name" }
      const profile = readLayerProfile(layer, entry)
      if (profile.error) return { ...base, error: profile.error }
      const checked = parseProfileValues(profile.values, layer.layer)
      return { ...base, file: profile.file, values: profile.values, status: "ok", error: checked.error ?? null }
    })
  }
  const entries = [...fromLayer(user), ...listRepoProfiles(repo, run), ...fromLayer(builtin)]
  const holder = new Map()
  for (const entry of entries) {
    if (entry.name && !holder.has(entry.name)) holder.set(entry.name, entry.layer)
    entry.shadowedBy = entry.name && holder.get(entry.name) !== entry.layer ? holder.get(entry.name) : null
  }
  return entries
}

const listRepoProfiles = (repo, run) => {
  const dir = repo ? readProfileDir(repo) : { absent: true }
  if (dir.absent) return []
  if (dir.error) return [{ name: null, file: PROFILE_DIR, layer: "repo", values: null, status: null, error: dir.error }]
  return dir.entries.map((entry) => {
    const name = entry.slice(0, -3)
    const file = `${PROFILE_DIR}/${entry}`
    const result = (status, error, values = null) => ({ name, file, layer: "repo", values, status, error })
    if (!LENS_NAME.test(name)) return result(null, "invalid name")
    const problem = checkSourcePath(repo, file)
    if (problem) return result(null, `${problem} (${file})`)
    const parsed = readProfile(repo, file)
    const git = trackedState(repo, file, parsed.raw, run)
    if (git.error) return result(null, git.error)
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

const applyProfile = ({ wd, repo, mode, run, sources }) => {
  const argsFile = join(wd, "args.txt")
  const diffFile = join(wd, "diff.patch")
  if ((mode && mode !== "uncommitted") || !existsSync(argsFile)) return fail(USAGE)
  const tokens = readTokens(argsFile)
  const pending = resolveSettings(tokens)
  if (pending.error) return fail(pending.error)
  if (!pending.profile) return fail("no profile=<name> in args.txt")
  const { name } = pending.profile
  if (repo && !existsSync(diffFile)) return fail(USAGE)
  const changed = repo ? parseDiff(readFileSync(diffFile, "utf8")).flatMap((s) => [s.path, s.oldPath]).filter(Boolean) : []
  const profile = loadProfile({ repo, name, changed, run, sources })
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

const listProfileLines = (repo, sources) => {
  const defaults = Object.entries(SETTINGS).filter(([, { default: value }]) => value !== null).map(([key, { default: value }]) => `${key}=${value}`)
  const lines = [`defaults (built-in): ${defaults.join(" | ")}`]
  const entries = listProfiles(repo, { sources })
  if (!entries.some((entry) => entry.layer === "repo")) lines.push(`no profiles in ${PROFILE_DIR}/`)
  for (const entry of entries) {
    const shadowed = entry.shadowedBy ? `, shadowed by ${entry.shadowedBy}` : ""
    const label = entry.name ? `${entry.name} (${entry.layer}${shadowed})` : `${entry.file} (${entry.layer})`
    if (entry.error) {
      lines.push(`${label}: invalid (${entry.error})`)
      continue
    }
    const values = new Map(parseProfileValues(entry.values, entry.layer).parsed.map(({ key, value }) => [key, value]))
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
    const named = profileKey(rawKey)
    if (named.error) return named
    const { key } = named
    if (!raw) {
      updates.push({ key, value: null })
      continue
    }
    const result = parseValue(key, raw)
    if (result.error) return { error: result.error }
    // The writer writes repository profiles only.
    if (repoLensesProblem(key, result.value)) return { error: REPO_LENSES_ERROR }
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
const editProfile = ({ repo, argsFile, sources }) => {
  const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  if (inside.error || inside.status !== 0) return fail(`not a git repository (${repo})`)
  const tokens = readTokens(argsFile)
  if (!tokens.length) return listProfileLines(repo, sources)
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

const PRESETS = new URL("../presets/", import.meta.url).pathname

/**
 * Creates `target` with `content` only if nothing is there: an exclusive temp file in the same
 * directory, then `link`, which never follows or replaces whatever holds the name. Returns `null`,
 * `"exists"` or the error code.
 */
const createFile = (dir, target, content) => {
  const tmp = join(dir, `.init.${randomBytes(6).toString("hex")}.tmp`)
  let fd = null
  let created = false
  try {
    fd = openSync(tmp, "wx", 0o644)
    created = true
    writeFileSync(fd, content)
    closeSync(fd)
    fd = null
    try {
      linkSync(tmp, target)
    } catch (error) {
      if (error.code === "EEXIST") return "exists"
      throw error
    }
    return null
  } catch (error) {
    return String(error.code ?? error.message)
  } finally {
    if (fd !== null) closeSync(fd)
    if (created) rmSync(tmp, { force: true })
  }
}

/** /consensus-review:init-lenses: copies presets/{lenses,profiles}/*.md (all, or the names given). Never commits. */
const initPresets = ({ repo, argsFile }) => {
  const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  if (inside.error || inside.status !== 0) return fail(`not a git repository (${repo})`)
  const presets = ["lenses", "profiles"].flatMap((kind) => readdirSync(join(PRESETS, kind))
    .filter((entry) => entry.endsWith(".md")).sort().map((entry) => ({ kind, name: entry.slice(0, -3), entry })))
  const names = readTokens(argsFile)
  const available = [...new Set(presets.map((p) => p.name))].sort()
  const unknown = names.filter((name) => !available.includes(name))
  if (unknown.length) return fail(`init: no such lens or profile ${unknown.join(", ")} (available: ${available.join(", ")})`)
  const chosen = names.length ? presets.filter((p) => names.includes(p.name)) : presets
  const dirs = [PROFILE_PARENT, ...new Set(chosen.map((p) => `${PROFILE_PARENT}/${p.kind}`))]
  const missing = []
  for (const dir of dirs) {
    const problem = checkSourcePath(repo, dir, "dir")
    if (problem === "absent") missing.push(dir)
    else if (problem) return fail(`init: ${problem} (${dir})`)
  }
  try {
    for (const dir of missing) mkdirSync(join(repo, dir))
  } catch (error) {
    return fail(`init: cannot create the directory (${String(error.code ?? error.message)})`)
  }
  const out = []
  const created = []
  for (const { kind, entry } of chosen) {
    const file = `${PROFILE_PARENT}/${kind}/${entry}`
    const result = createFile(join(repo, PROFILE_PARENT, kind), join(repo, file), readFileSync(join(PRESETS, kind, entry)))
    if (result === "exists") out.push(`${file}: exists, kept`)
    else if (result) {
      process.stdout.write(out.map((line) => `${line}\n`).join(""))
      return fail(`init: write failed (${result}) (${file})`)
    } else {
      out.push(`${file}: created`)
      created.push(file)
    }
  }
  if (created.length) {
    const paths = created.join(" ")
    out.push(`Not applied until committed: git add -- ${paths} && git commit -m 'Add review lenses and profiles' -- ${paths}`)
  }
  process.stdout.write(`${out.join("\n")}\n`)
  return 0
}

/** `run` (spawnSync's shape) and `sources` (see `sourceRoots`) are injectable for tests. */
export function main(argv, { run, sources } = {}) {
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
    return editProfile({ repo: values.repo, argsFile: file, sources })
  }
  if (positionals[0] === "init") {
    if (!values.repo || !existsSync(values.repo) || !file || !existsSync(file)) return fail(USAGE)
    return initPresets({ repo: values.repo, argsFile: file })
  }
  if (!values.wd || !existsSync(values.wd)) return fail(USAGE)
  if (positionals[0] === "profile") {
    return applyProfile({ wd: values.wd, repo: values.repo ?? null, mode: values.mode ?? null, run, sources })
  }
  if (positionals[0] !== "resolve" || !file || !existsSync(file)) return fail(USAGE)
  const resolved = resolveSettings(readTokens(file))
  if (resolved.error) return fail(resolved.error)
  process.stdout.write(writeSettings(values.wd, resolved))
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
