#!/usr/bin/env node
// Checks the invariants of the plugin's markdown that generation cannot cover. Free, deterministic,
// no model, no network. Exits 1 naming file and line.
//
// What each check is for is in docs/eval-layer-plan.md §3.4. The load-bearing one is L2: read-only
// is this plugin's headline promise, and a dropped `disallowedTools` line silently arms five Opus
// agents with Write.
//
//   node scripts/lint-prompts.mjs            lint the repo
//   node scripts/lint-prompts.mjs --dir DIR  lint a copy (used by the tests)
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, basename } from "node:path"

const SELF_DIR = dirname(fileURLToPath(import.meta.url))

/** Agents that review or verify, and must therefore never hold a mutating tool. */
const READ_ONLY_REQUIRED = /-reviewer$|-verifier$/

/**
 * Parse the leading `---` frontmatter as flat `key: value` pairs, which is all these files use.
 * Returns null when there is no frontmatter at all. Values keep their raw text; comparisons that
 * care about spacing normalise it themselves.
 */
export function parseFrontmatter(text) {
  const lines = text.split("\n")
  if (lines[0]?.trim() !== "---") return null
  const out = {}
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === "---") return { data: out, endLine: i + 1 }
    const at = line.indexOf(":")
    if (at <= 0) continue
    out[line.slice(0, at).trim()] = { value: line.slice(at + 1).trim(), line: i + 1 }
  }
  return null // unterminated frontmatter
}

/**
 * Vocabulary tokens that appear inside a backtick span. Prose mentions are deliberately NOT
 * counted — `agents/impact-reviewer.md` says "(Original P3 collapses here.)" about a severity it
 * does not use, and treating that as drift was a false positive.
 *
 * Tokenising *within* each span matters as much as finding the spans: the verifier declares its
 * severities inside one backticked JSON template, `"suggested_severity": "P0|P1|P2|null"`. Matching
 * only whole-span `` `P0` `` missed those, which would have let an invented severity hide inside a
 * template — the exact direction L5b exists to catch.
 */
export function vocabulary(text, re) {
  const found = new Set()
  const anchored = new RegExp(`^(?:${re})$`)
  for (const span of text.match(/`[^`\n]+`/g) ?? []) {
    for (const token of span.slice(1, -1).split(/[^A-Za-z0-9_]+/)) {
      if (token && anchored.test(token)) found.add(token)
    }
  }
  return found
}

/**
 * The verdict set the verifier declares in its own output template, e.g. from
 * `"verdict": "confirmed|unconfirmed|refuted"`. This is the one place the vocabulary appears as a
 * CLOSED set, which is why it can be compared for equality in both directions — unlike a search for
 * unknown words, which cannot find what it cannot name.
 */
export function verdictAlternation(text) {
  const m = text.match(/"verdict"\s*:\s*"([A-Za-z|]+)"/)
  if (!m) return null
  return new Set(m[1].split("|").filter(Boolean))
}

export function lint(root) {
  const problems = []
  const fail = (file, line, message) => problems.push({ file, line, message })

  const agentsDir = join(root, "agents")
  const commandsDir = join(root, "commands")
  const barsPath = join(root, "contracts/severity-bars.md")

  if (!existsSync(agentsDir)) return [{ file: "agents/", line: 0, message: "directory is missing" }]

  const bars = readFileSync(barsPath, "utf8")
  const contractSeverities = vocabulary(bars, "P[0-9]")
  const contractVerdicts = vocabulary(bars, "confirmed|unconfirmed|refuted|reduced")
  // `reduced` is a normalized outcome the verifier never emits (contracts/severity-bars.md), so it
  // is permitted to appear and is never required of anyone.
  const emittedVerdicts = new Set([...contractVerdicts].filter((v) => v !== "reduced"))

  const agentFiles = readdirSync(agentsDir).filter((f) => f.endsWith(".md")).sort()
  const agentNames = new Set()

  for (const file of agentFiles) {
    const rel = `agents/${file}`
    const text = readFileSync(join(agentsDir, file), "utf8")
    const stem = basename(file, ".md")
    const fm = parseFrontmatter(text)

    // L1 — frontmatter present, complete, and naming the file it lives in.
    if (!fm) {
      fail(rel, 1, "L1: no terminated `---` frontmatter block")
      continue
    }
    for (const key of ["name", "description", "model"]) {
      if (!fm.data[key]) fail(rel, 1, `L1: frontmatter is missing \`${key}\``)
    }
    if (fm.data.name && fm.data.name.value !== stem) {
      fail(rel, fm.data.name.line, `L1: frontmatter name \`${fm.data.name.value}\` does not match the filename \`${stem}\``)
    }
    if (fm.data.name) agentNames.add(fm.data.name.value)

    // L2 — the read-only guarantee.
    if (READ_ONLY_REQUIRED.test(stem)) {
      const tools = fm.data.disallowedTools
      if (!tools) {
        fail(rel, 1, "L2: review agent has no `disallowedTools` — the read-only guarantee is gone")
      } else {
        const denied = new Set(tools.value.split(",").map((t) => t.trim()).filter(Boolean))
        for (const required of ["Write", "Edit"]) {
          if (!denied.has(required)) fail(rel, tools.line, `L2: \`disallowedTools\` no longer denies \`${required}\``)
        }
      }
    }

    // L5a — the vocabulary the agent is contracted to emit must still be there.
    const severities = vocabulary(text, "P[0-9]")
    const verdicts = vocabulary(text, "confirmed|unconfirmed|refuted|reduced")
    for (const sev of contractSeverities) {
      if (!severities.has(sev)) fail(rel, 1, `L5a: agent no longer names the contracted severity \`${sev}\``)
    }
    // Only the verifier emits verdicts; the reviewers legitimately never mention them.
    if (stem.endsWith("-verifier")) {
      for (const v of emittedVerdicts) {
        if (!verdicts.has(v)) fail(rel, 1, `L5a: verifier no longer names the contracted verdict \`${v}\``)
      }
    }

    // L5b — nothing outside the contract. This works for severities because `P[0-9]` is a SHAPE:
    // any `P4` is recognisably a severity and can be judged against the contract.
    for (const sev of severities) {
      if (!contractSeverities.has(sev)) {
        fail(rel, 1, `L5b: \`${sev}\` is not a severity contracts/severity-bars.md defines`)
      }
    }
    // There is deliberately no L5b for verdicts. The pattern that finds them IS the contract list,
    // so an invented word like `maybe` cannot match it — searching for unknown verdicts by name is
    // vacuous. L5c below covers the direction that is actually reachable.
    if (stem.endsWith("-verifier")) {
      const declared = verdictAlternation(text)
      if (!declared) {
        fail(rel, 1, "L5c: no `\"verdict\": \"a|b|c\"` alternation found — the verifier's emission contract is unreadable")
      } else {
        const want = [...emittedVerdicts].sort().join("|")
        const got = [...declared].sort().join("|")
        if (want !== got) {
          fail(rel, 1, `L5c: the verifier's declared verdict set is \`${got}\`, but the contract's is \`${want}\``)
        }
      }
    }
  }

  // L6 — every dispatched agent exists, and every agent is dispatched.
  const dispatched = new Set()
  if (existsSync(commandsDir)) {
    for (const file of readdirSync(commandsDir).filter((f) => f.endsWith(".md")).sort()) {
      const rel = `commands/${file}`
      const text = readFileSync(join(commandsDir, file), "utf8")
      text.split("\n").forEach((line, i) => {
        // Forward direction is strict: only the declared dispatch form counts, because a dangling
        // `subagent_type` is a real break and matching bare names picked up prose.
        for (const m of line.matchAll(/subagent_type:\s*["`']?([A-Za-z0-9:_-]+)["`']?/g)) {
          const name = m[1].replace(/^consensus-review:/, "")
          dispatched.add(name)
          if (!agentNames.has(name)) fail(rel, i + 1, `L6: dispatches \`${name}\`, which does not exist in agents/`)
        }
        // Reverse direction is loose on purpose. `commands/consensus-review.md` spawns
        // `finding-verifier` by backticked name and Task, never via `subagent_type:`, so requiring
        // that form here reported a live agent as orphaned. A false "it is referenced" is far
        // cheaper than a false alarm, and the forward check still guards precision.
        for (const m of line.matchAll(/`(?:consensus-review:)?([a-z0-9-]+)`/g)) {
          if (agentNames.has(m[1])) dispatched.add(m[1])
        }
      })
    }
  }
  for (const name of [...agentNames].sort()) {
    if (!dispatched.has(name)) fail(`agents/${name}.md`, 1, `L6: no command dispatches \`${name}\``)
  }

  return problems
}

// Only run when invoked directly, so the tests can import `lint`.
if (process.argv[1] && process.argv[1].endsWith("lint-prompts.mjs")) {
  const dirFlag = process.argv.indexOf("--dir")
  const root = dirFlag >= 0 ? process.argv[dirFlag + 1] : join(SELF_DIR, "..")
  const problems = lint(root)
  for (const p of problems) console.error(`${p.file}:${p.line}: ${p.message}`)
  if (problems.length) {
    console.error(`lint-prompts: ${problems.length} problem(s)`)
    process.exit(1)
  }
  console.log("lint-prompts: clean")
}
