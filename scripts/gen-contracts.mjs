#!/usr/bin/env node
// Generates the inline findings-schema block in commands/consensus-review.md from the
// canonical contracts/finding.schema.json, so the two can never drift (see the F3 regression).
//
//   node scripts/gen-contracts.mjs          rewrite the block
//   node scripts/gen-contracts.mjs --check  exit non-zero if the block is out of sync
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SCHEMA = join(ROOT, "contracts/finding.schema.json")
const TARGET = join(ROOT, "commands/consensus-review.md")
const BEGIN = "<!-- BEGIN GENERATED: contracts/finding.schema.json -->"
const END = "<!-- END GENERATED -->"

const check = process.argv.includes("--check")
const schema = readFileSync(SCHEMA, "utf8").trimEnd()

// Fail loudly rather than emitting a schema OpenAI strict mode would reject at run time.
const parsed = JSON.parse(schema)
;(function strict(node, path) {
  if (node && typeof node === "object" && node.type === "object") {
    if (node.additionalProperties !== false) throw new Error(`${path}: missing "additionalProperties": false`)
    const props = Object.keys(node.properties ?? {})
    const required = node.required ?? []
    for (const p of props) if (!required.includes(p)) throw new Error(`${path}: "required" omits "${p}"`)
    for (const p of props) strict(node.properties[p], `${path}.${p}`)
  }
  if (node && node.type === "array" && node.items) strict(node.items, `${path}[]`)
})(parsed, "$")

const current = readFileSync(TARGET, "utf8")
const start = current.indexOf(BEGIN)
const stop = current.indexOf(END)
if (start < 0 || stop < 0 || stop < start) {
  console.error(`gen-contracts: markers not found in ${TARGET} — expected ${BEGIN} … ${END}`)
  process.exit(2)
}

const block = `${BEGIN}\n\`\`\`json\n${schema}\n\`\`\`\n`
const next = current.slice(0, start) + block + current.slice(stop)

if (check) {
  if (next !== current) {
    console.error("gen-contracts: commands/consensus-review.md is OUT OF SYNC with contracts/finding.schema.json")
    console.error("run: node scripts/gen-contracts.mjs")
    process.exit(1)
  }
  console.log("gen-contracts: in sync")
  process.exit(0)
}

if (next === current) {
  console.log("gen-contracts: already in sync, nothing written")
} else {
  writeFileSync(TARGET, next)
  console.log("gen-contracts: regenerated the schema block in commands/consensus-review.md")
}
