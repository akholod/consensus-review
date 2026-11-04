import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { assertStrictSchema } from "../../scripts/lib/json-schema.mjs"
import { VERDICTS } from "../../scripts/lib/lanes.mjs"

const sortDeep = (o) =>
  Array.isArray(o) ? o.map(sortDeep)
    : o && typeof o === "object" ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortDeep(o[k])]))
    : o

const embedded = () => {
  const md = readFileSync(new URL("../../commands/consensus-review.md", import.meta.url), "utf8")
  const m = md.match(/<!-- BEGIN GENERATED[^>]*-->\n```json\n([\s\S]*?)\n```\n<!-- END GENERATED -->/)
  assert.ok(m, "the generated schema block must be present in commands/consensus-review.md")
  return JSON.parse(m[1])
}

test("/consensus-review's embedded schema is semantically identical to the released version", () => {
  // Guards the one change made to a released command: the schema is now generated rather than
  // hand-maintained, and generating it must not alter what codex is actually sent.
  let released
  try {
    const md = execFileSync("git", ["show", "1f1189b:commands/consensus-review.md"], {
      cwd: new URL("../..", import.meta.url).pathname, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    })
    released = JSON.parse(md.split("```json")[1].split("```")[0])
  } catch {
    return // released revision unavailable (shallow clone); the parity check below still runs
  }
  assert.deepEqual(sortDeep(embedded()), sortDeep(released))
})

test("the embedded schema stays OpenAI strict-mode compliant", () => {
  // A schema that violates strict mode is rejected with HTTP 400 before any review work starts,
  // which is exactly how the codex lane silently died in 0.4.0.
  assert.doesNotThrow(() => assertStrictSchema(embedded()))
})

test("the canonical contract and the embedded block agree", () => {
  const canonical = JSON.parse(readFileSync(new URL("../../contracts/finding.schema.json", import.meta.url), "utf8"))
  assert.deepEqual(sortDeep(embedded()), sortDeep(canonical))
})

const contract = (name) => JSON.parse(readFileSync(new URL(`../../contracts/${name}`, import.meta.url), "utf8"))

test("every schema sent via --output-schema is OpenAI strict-mode compliant", () => {
  for (const name of ["finding.schema.json", "verdict.schema.json"]) {
    assert.doesNotThrow(() => assertStrictSchema(contract(name)), name)
  }
})

test("the refuter verdict enum stays inside the shared verification vocabulary", () => {
  const bars = readFileSync(new URL("../../contracts/severity-bars.md", import.meta.url), "utf8")
  const section = bars.split("## Verification vocabulary")[1]
  assert.ok(section, "contracts/severity-bars.md must keep its Verification vocabulary section")
  const vocabulary = section.split("\n\n")[1]
  const words = [...vocabulary.matchAll(/`([a-z_]+)`/g)].map((m) => m[1])
  const verdicts = contract("verdict.schema.json").properties.verdicts.items.properties.verdict.enum
  for (const v of verdicts) assert.ok(words.includes(v), `${v} is not in the verification vocabulary`)
  assert.deepEqual(verdicts, VERDICTS, "scripts/lib/lanes.mjs must accept exactly the schema's verdicts")
})

test("§5 runs the consultants only through the lane helper, in one backgrounded call", () => {
  // A direct call bypasses the retry, the timeout kill and the status files, and a foreground call
  // hits the host's ~600 s Bash limit before the default 2×T budget.
  const md = readFileSync(new URL("../../commands/consensus-review.md", import.meta.url), "utf8")
  const s5 = md.split("## 5. ")[1]?.split("\n## 6. ")[0]
  assert.ok(s5, "commands/consensus-review.md must keep its section 5")
  assert.doesNotMatch(s5, /codex exec|pi -p\b/)
  assert.match(s5, /run_in_background/)
  assert.match(s5, /scripts\/run-lane\.mjs/)
  assert.match(s5, /decide --wd "\$WD" --phase review/)
})
