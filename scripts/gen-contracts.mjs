#!/usr/bin/env node
// Generates every derived copy of a contract from its canonical source, so the copies can never
// drift (see the F3 regression):
//
//   commands/consensus-review.md      <- contracts/finding.schema.json          (verbatim JSON)
//   prompts/loop-review/discovery.md  <- loop-payload.schema.json#/$defs/discoveryPayload (sketch)
//   prompts/loop-review/verify.md     <- loop-payload.schema.json#/$defs/verifierPayload  (sketch)
//
// It also checks that loopFinding is still the declared projection of the consensus finding.
//
//   node scripts/gen-contracts.mjs          rewrite the blocks
//   node scripts/gen-contracts.mjs --check  exit non-zero if anything is out of sync
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { resolveRef } from "./lib/json-schema.mjs"
import { renderSketch } from "./lib/sketch.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const FINDING = "contracts/finding.schema.json"
const LOOP = "contracts/loop-payload.schema.json"
const END = "<!-- END GENERATED -->"

const check = process.argv.includes("--check")
const read = (rel) => readFileSync(join(ROOT, rel), "utf8")

const findingSchema = read(FINDING).trimEnd()
const findingRoot = JSON.parse(findingSchema)
const loopRoot = JSON.parse(read(LOOP))

// Fail loudly rather than emitting a schema OpenAI strict mode would reject at run time.
;(function strict(node, path) {
  if (node && typeof node === "object" && node.type === "object") {
    if (node.additionalProperties !== false) throw new Error(`${path}: missing "additionalProperties": false`)
    const props = Object.keys(node.properties ?? {})
    const required = node.required ?? []
    for (const p of props) if (!required.includes(p)) throw new Error(`${path}: "required" omits "${p}"`)
    for (const p of props) strict(node.properties[p], `${path}.${p}`)
  }
  if (node && node.type === "array" && node.items) strict(node.items, `${path}[]`)
})(findingRoot, "$")

/**
 * loopFinding must remain the consensus finding minus exactly the declared omissions. Any other
 * difference — a type, an enum, a required flag, an extra property — is undeclared drift and fails.
 * Runtime tolerances and strictnesses are NOT checked here: they are disagreements with the
 * runtime, not with the sibling schema, and test/unit/conformance.test.mjs owns them.
 */
export function projectionProblems(consensusItems, loopFinding, projection) {
  const problems = []
  const omissions = new Set(projection?.omissions ?? [])
  const src = consensusItems.properties ?? {}
  const dst = loopFinding.properties ?? {}

  for (const key of Object.keys(src)) {
    if (omissions.has(key)) {
      if (key in dst) problems.push(`"${key}" is declared an omission but is present in loopFinding`)
      continue
    }
    if (!(key in dst)) {
      problems.push(`loopFinding drops "${key}" without declaring it in x-projection.omissions`)
      continue
    }
    const a = JSON.stringify(src[key])
    const b = JSON.stringify(dst[key])
    if (a !== b) problems.push(`"${key}" differs from the consensus contract:\n    consensus: ${a}\n    loop:      ${b}`)
  }
  for (const key of Object.keys(dst)) {
    if (!(key in src)) problems.push(`loopFinding adds "${key}", which the consensus contract does not have`)
  }
  for (const key of omissions) {
    if (!(key in src)) problems.push(`x-projection.omissions names "${key}", which the consensus contract does not have`)
  }

  const wantRequired = (consensusItems.required ?? []).filter((k) => !omissions.has(k))
  const gotRequired = loopFinding.required ?? []
  const missing = wantRequired.filter((k) => !gotRequired.includes(k))
  const extra = gotRequired.filter((k) => !wantRequired.includes(k))
  if (missing.length) problems.push(`loopFinding.required omits ${missing.join(", ")}`)
  if (extra.length) problems.push(`loopFinding.required adds ${extra.join(", ")}`)

  return problems
}

const projection = loopRoot["x-projection"]
const consensusItems = resolveRef(findingRoot, "#/properties/findings/items")
const loopFinding = resolveRef(loopRoot, projection.target)
const drift = projectionProblems(consensusItems, loopFinding, projection)
if (drift.length) {
  console.error(`gen-contracts: ${LOOP} is not the declared projection of ${FINDING}`)
  for (const p of drift) console.error(`  - ${p}`)
  process.exit(1)
}

/** One generated block per entry: which file, which source, and the body to write. */
const JOBS = [
  {
    target: "commands/consensus-review.md",
    source: FINDING,
    body: `\`\`\`json\n${findingSchema}\n\`\`\``,
  },
  {
    target: "prompts/loop-review/discovery.md",
    source: `${LOOP}#/$defs/discoveryPayload`,
    body: `\`\`\`\n${renderSketch(loopRoot, "#/$defs/discoveryPayload")}\n\`\`\``,
  },
  {
    target: "prompts/loop-review/verify.md",
    source: `${LOOP}#/$defs/verifierPayload`,
    body: `\`\`\`\n${renderSketch(loopRoot, "#/$defs/verifierPayload")}\n\`\`\``,
  },
]

let changed = 0
let stale = 0

for (const job of JOBS) {
  const begin = `<!-- BEGIN GENERATED: ${job.source} -->`
  const path = join(ROOT, job.target)
  const current = readFileSync(path, "utf8")
  const start = current.indexOf(begin)
  const stop = current.indexOf(END, start < 0 ? 0 : start)
  if (start < 0 || stop < 0 || stop < start) {
    console.error(`gen-contracts: markers not found in ${job.target} — expected ${begin} … ${END}`)
    process.exit(2)
  }

  const next = current.slice(0, start) + `${begin}\n${job.body}\n` + current.slice(stop)
  if (next === current) continue

  if (check) {
    console.error(`gen-contracts: ${job.target} is OUT OF SYNC with ${job.source}`)
    stale++
  } else {
    writeFileSync(path, next)
    console.log(`gen-contracts: regenerated the block in ${job.target}`)
    changed++
  }
}

if (check) {
  if (stale) {
    console.error("run: node scripts/gen-contracts.mjs")
    process.exit(1)
  }
  console.log(`gen-contracts: in sync (${JOBS.length} generated blocks, projection verified)`)
} else if (!changed) {
  console.log("gen-contracts: already in sync, nothing written")
}
