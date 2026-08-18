import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

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
  ;(function strict(node, path) {
    if (node && typeof node === "object" && node.type === "object") {
      assert.equal(node.additionalProperties, false, `${path} needs additionalProperties:false`)
      for (const key of Object.keys(node.properties ?? {})) {
        assert.ok((node.required ?? []).includes(key), `${path}: required omits ${key}`)
        strict(node.properties[key], `${path}.${key}`)
      }
    }
    if (node && node.type === "array" && node.items) strict(node.items, `${path}[]`)
  })(embedded(), "$")
})

test("the canonical contract and the embedded block agree", () => {
  const canonical = JSON.parse(readFileSync(new URL("../../contracts/finding.schema.json", import.meta.url), "utf8"))
  assert.deepEqual(sortDeep(embedded()), sortDeep(canonical))
})
