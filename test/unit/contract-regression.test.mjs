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

const command = () => readFileSync(new URL("../../commands/consensus-review.md", import.meta.url), "utf8")
const section = (md, n) => md.split(`\n## ${n}. `)[1]?.split("\n## ")[0]

test("§9 calls archive-run.mjs finish only on the file branch, before the report, from INVOKE", () => {
  // no-file promises zero writes; an archive call outside the file branch would break that promise.
  const md = command()
  const calls = md.split("\n").filter((l) => /archive-run\.mjs"? finish/.test(l) && !/salvage/.test(l))
  const s1 = section(md, 1)
  const s9 = section(md, 9)
  assert.ok(s1 && s9, "commands/consensus-review.md must keep sections 1 and 9")
  // the only invocation outside §9 is the salvage hint printed with the work dir in §1
  assert.equal(md.split("archive-run.mjs").length - 1, 2, "archive-run.mjs: one salvage hint in §1, one call in §9")
  assert.match(s1, /archive-run\.mjs finish --wd <WD>/)
  assert.equal(calls.length, 1)
  assert.ok(s9.includes(calls[0]), "the finish call lives in §9")
  assert.match(calls[0], /^cd <literal INVOKE> && node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/archive-run\.mjs" finish --wd <literal WD> --report /)
  assert.match(calls[0], /--args-json '/)
  assert.match(s9, /on the file branch only, never with `no-file`/)
  assert.match(s9, /Before writing the report/)
  assert.match(s9, /--off with archive=off/)
  assert.match(s9, /\nArchive: </, "the header block carries the Archive line")
  assert.match(s9, /last terminal line/)
})

test("the arbiter writes the files the archive expects, with one id space", () => {
  const md = command()
  assert.match(section(md, 0), /`archive=off`/)
  assert.match(section(md, 0), /no run archive either/)
  assert.match(section(md, 1), /print `work dir: <WD>`/)
  assert.match(section(md, 1), /INVOKE=/)
  assert.match(section(md, 3), /\$WD\/triage\.json/)
  assert.match(section(md, 6), /\$WD\/claude-findings\.json/)
  assert.match(section(md, 7), /\$WD\/synthesis\.json/)
  const s8 = section(md, 8)
  const strict = s8.indexOf("**Strict — the default.**")
  assert.ok(strict > 0)
  // ids and the verifier file belong to both modes, so both must come before the strict branch
  assert.ok(s8.indexOf("synthesis.json") < strict, "§8 reuses synthesis ids before the strict/basic split")
  assert.ok(s8.indexOf("$WD/verifier.verdicts.json") < strict, "verifier.verdicts.json is written in basic mode too")
  assert.doesNotMatch(s8, /Give every P0\/P1 a string id/, "§8 must not renumber")
})

test("no-file still means zero writes", () => {
  const md = command()
  assert.match(md, /none at all with `no-file`/)
  assert.match(section(md, 0), /performs \*\*zero\*\* writes anywhere on disk/)
  assert.match(md.split("## Hard rules")[1], /with `no-file` there is no write at all/)
})
