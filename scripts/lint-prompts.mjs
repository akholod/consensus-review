#!/usr/bin/env node
// Checks the invariants of the plugin's markdown that generation cannot cover. Free, deterministic,
// no model, no network. Exits 1 naming file and line.
//
// What each check is for is in docs/design/eval-layer-plan.md §3.4. The load-bearing one is L2: read-only
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

/** Marker of the generated vote sketch every verifier must carry. */
const VERDICT_BLOCK = "<!-- BEGIN GENERATED: contracts/verdict.schema.json"

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
 * Tokenising *within* each span matters as much as finding the spans: the verifier once declared
 * its severities inside one backticked JSON template, `"suggested_severity": "P0|P1|P2|null"`. Matching
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

export function lint(root) {
  const problems = []
  const fail = (file, line, message) => problems.push({ file, line, message })

  const agentsDir = join(root, "agents")
  const commandsDir = join(root, "commands")
  const barsPath = join(root, "contracts/severity-bars.md")

  if (!existsSync(agentsDir)) return [{ file: "agents/", line: 0, message: "directory is missing" }]

  const bars = readFileSync(barsPath, "utf8")
  const contractSeverities = vocabulary(bars, "P[0-9]")

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
    for (const sev of contractSeverities) {
      if (!severities.has(sev)) fail(rel, 1, `L5a: agent no longer names the contracted severity \`${sev}\``)
    }

    // L5b — nothing outside the contract. This works for severities because `P[0-9]` is a SHAPE:
    // any `P4` is recognisably a severity and can be judged against the contract.
    for (const sev of severities) {
      if (!contractSeverities.has(sev)) {
        fail(rel, 1, `L5b: \`${sev}\` is not a severity contracts/severity-bars.md defines`)
      }
    }
    // L5c — the verifier's vote shape is generated from contracts/verdict.schema.json, so the lint
    // only checks the block is there; `gen-contracts --check` guards what it says.
    if (stem.endsWith("-verifier") && !text.includes(VERDICT_BLOCK)) {
      fail(rel, 1, `L5c: no \`${VERDICT_BLOCK}\` block — the verifier's vote contract is not generated`)
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

  // L7 — lenses reach a consultant only through the helper's --lenses-file, and never a refuter (D9):
  // the §5 run line carries the flag, the §8 refuter run line (with its continuations) does not.
  const consensus = join(commandsDir, "consensus-review.md")
  if (existsSync(consensus)) {
    const lines = readFileSync(consensus, "utf8").split("\n")
    const runs = { consultant: 0, refuter: 0 }
    lines.forEach((line, i) => {
      if (!line.trim().startsWith('node "$H" run ')) return
      let run = line
      for (let j = i; lines[j]?.trimEnd().endsWith("\\"); j++) run += lines[j + 1]
      const refuter = run.includes("-refuter")
      runs[refuter ? "refuter" : "consultant"]++
      if (refuter && run.includes("--lenses-file")) fail("commands/consensus-review.md", i + 1, "L7: the refuter run line passes `--lenses-file`; refuters must never get lenses")
      if (!refuter && !run.includes('[--lenses-file "$WD/<outputs.consultant>"]')) {
        fail("commands/consensus-review.md", i + 1, 'L7: the consultant run line must pass lenses via `[--lenses-file "$WD/<outputs.consultant>"]`')
      }
    })
    if (!runs.consultant) fail("commands/consensus-review.md", 1, 'L7: the §5 consultant run line (`node "$H" run `) is missing')
    if (!runs.refuter) fail("commands/consensus-review.md", 1, 'L7: the §8 refuter run line (`node "$H" run ` … `-refuter`) is missing')
  }

  // L7 on plan-review.md: the §5 lines validate against the plan schema, the §8 refuter lines keep the
  // default verdict schema, and no lenses reach either (none apply to a document).
  const plan = join(commandsDir, "plan-review.md")
  if (existsSync(plan)) {
    const rel = "commands/plan-review.md"
    const lines = readFileSync(plan, "utf8").split("\n")
    const runs = { consultant: 0, refuter: 0 }
    lines.forEach((line, i) => {
      if (!line.trim().startsWith('node "$H" run ')) return
      let run = line
      for (let j = i; lines[j]?.trimEnd().endsWith("\\"); j++) run += lines[j + 1]
      const refuter = run.includes("-refuter")
      runs[refuter ? "refuter" : "consultant"]++
      if (run.includes("--lenses-file")) fail(rel, i + 1, "L7: a plan-review run line passes `--lenses-file`; lenses do not apply to a document")
      if (refuter && run.includes("--schema")) fail(rel, i + 1, "L7: the refuter run line passes `--schema`; refuters keep the default verdict schema")
      if (!refuter && !/--schema "[^"]*plan-finding\.schema\.json"/.test(run)) {
        fail(rel, i + 1, "L7: the §5 run line must pass `--schema` with `plan-finding.schema.json`")
      }
    })
    if (!runs.consultant) fail(rel, 1, 'L7: the §5 consultant run line (`node "$H" run `) is missing')
    if (!runs.refuter) fail(rel, 1, 'L7: the §8 refuter run line (`node "$H" run ` … `-refuter`) is missing')
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
