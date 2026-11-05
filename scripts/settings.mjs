#!/usr/bin/env node
// Resolves the /consensus-review arguments against one table of settings, so the arbiter reads
// settings.json instead of interpreting flags in prose.
//
//   resolve --wd <WD> --args-file <file>
//
// Splits the file on whitespace, writes <WD>/settings.json atomically and prints it, exit 0. A
// known key with a bad value prints the message to stderr and exits 2 with nothing written; a
// usage error exits 2 too. Precedence is flag > profile > default.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { PI_MODEL_ID } from "./lib/lanes.mjs"

const USAGE = "usage: settings.mjs resolve --wd <WD> --args-file <file>"
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

const renderLines = (settings, ignored, clamped) => {
  const parts = Object.entries(settings).map(([key, { value, source }]) => {
    const note = clamped.has(key) ? `${source}, clamped` : source
    return `${key}=${renderValue(key, value)} (${note})`
  })
  const skipped = ignored.map(({ token, reason }) => `${token} (${reason})`)
  return {
    settings: `Settings: ${parts.join(" | ")}`,
    ignored: `Ignored args: ${skipped.length ? skipped.join(", ") : "none"}`,
  }
}

/**
 * Tokens are the whitespace-split arguments; `profile` is `{ name, values: { key: raw } }` or
 * null. Returns the resolved object or `{ error }`. The last token for a key wins.
 */
export function resolveSettings(tokens, { profile = null } = {}) {
  const settings = {}
  for (const [key, { default: value }] of Object.entries(SETTINGS)) settings[key] = { value, source: "default" }
  const clamped = new Set()

  if (profile) {
    for (const [rawKey, raw] of Object.entries(profile.values)) {
      const key = rawKey.toLowerCase()
      if (key === "target" || key === "profile") return { error: `profile ${profile.name}: ${key} is not a profile key` }
      if (!SETTINGS[key]) return { error: `profile ${profile.name}: unknown key ${rawKey}` }
      const result = parseValue(key, raw)
      if (result.error) return { error: `profile ${profile.name}: ${result.error}` }
      settings[key] = { value: result.value, source: "profile" }
      if (result.clamped) clamped.add(key)
    }
  }

  let target = { kind: "uncommitted", ref: null }
  let targetToken = null
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

  return { schema: 1, target, settings, ignored, lines: renderLines(settings, ignored, clamped) }
}

export function main(argv) {
  let values
  let positionals
  try {
    ({ values, positionals } = parseArgs({
      args: argv, options: { wd: { type: "string" }, "args-file": { type: "string" } }, allowPositionals: true,
    }))
  } catch (error) {
    process.stderr.write(`${USAGE}\n${error.message}\n`)
    return 2
  }
  const file = values["args-file"]
  const usable = positionals[0] === "resolve" && positionals.length === 1 && values.wd && file
  if (!usable || !existsSync(values.wd) || !existsSync(file)) {
    process.stderr.write(`${USAGE}\n`)
    return 2
  }
  const tokens = readFileSync(file, "utf8").split(/\s+/).filter(Boolean)
  const resolved = resolveSettings(tokens)
  if (resolved.error) {
    process.stderr.write(`${resolved.error}\n`)
    return 2
  }
  const text = `${JSON.stringify(resolved, null, 2)}\n`
  const path = join(values.wd, "settings.json")
  writeFileSync(`${path}.tmp`, text)
  renameSync(`${path}.tmp`, path)
  process.stdout.write(text)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
