import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { DENIED_TOOLS } from "../../src/loop-review/adapter.mjs"

const ROOT = new URL("../..", import.meta.url).pathname
const runtimeFiles = [
  ...readdirSync(join(ROOT, "src/loop-review")).map((f) => join("src/loop-review", f)),
  "bin/loop-review.mjs",
].filter((f) => f.endsWith(".mjs"))

const source = (rel) => readFileSync(join(ROOT, rel), "utf8")

// The README and commands/loop-review.md both promise this. Documentation drifts from code
// silently — the F3 regression in this repo is the precedent — so the promise is asserted.

test("a review pass is denied every tool that could read or change the repository", () => {
  for (const tool of ["Edit", "Write", "NotebookEdit", "Bash", "Task", "Read", "Grep", "Glob", "WebFetch", "WebSearch"]) {
    assert.ok(DENIED_TOOLS.includes(tool), `${tool} must be denied to a review pass`)
  }
})

test("the runtime issues no mutating git or gh command", () => {
  const mutating = /"(commit|push|add|checkout|reset|apply|am|merge|rebase|stash|clean|rm|mv|tag)"/
  for (const file of runtimeFiles) {
    const text = source(file)
    const hit = text.match(mutating)
    assert.equal(hit, null, `${file} contains a mutating git verb: ${hit?.[0]}`)
  }
})

test("the only forge call reads", () => {
  const text = runtimeFiles.map(source).join("\n")
  for (const m of text.matchAll(/execFileSync\("gh", \[([^\]]*)\]/g)) {
    assert.match(m[1], /"pr", "diff"/, `unexpected gh call: gh ${m[1]}`)
  }
})

test("the report is the runtime's only write, and it is suppressible", () => {
  const writes = []
  for (const file of runtimeFiles) {
    // call sites only — the import statement names the same symbol
    const body = source(file).replace(/^import[\s\S]*?from "[^"]+"$/gm, "")
    for (const m of body.matchAll(/\b(writeFileSync|appendFileSync|rmSync|unlinkSync|renameSync|rmdirSync)\s*\(/g)) {
      writes.push(`${file}:${m[1]}`)
    }
  }
  assert.deepEqual(writes, ["bin/loop-review.mjs:writeFileSync"], `unexpected writes: ${writes.join(", ")}`)
  // and that single write is behind --no-file
  assert.match(source("bin/loop-review.mjs"), /if \(!noFile\) \{[\s\S]*?writeFileSync/)
})
