import { test } from "node:test"
import assert from "node:assert/strict"
import {
  parseDiff, changedLines, classify, risksFor, deriveCells, isTrivial, isHighRisk,
  fnmatch, parseInstructionsYaml, instructionMatches, selectInstructions, touchesHighRisk,
  diffHash, buildStaticPrefix,
} from "../../src/loop-review/context.mjs"
import { SURFACE, RISK } from "../../src/loop-review/schema.mjs"

const DIFF = `diff --git a/src/pay.js b/src/pay.js
index 111..222 100644
--- a/src/pay.js
+++ b/src/pay.js
@@ -10,3 +10,4 @@ function refund(order) {
-  if (!order.paid) throw new Error("not paid")
+  // guard removed
+  const x = 1
   return gateway.refund(order.id)
 }
diff --git a/old/name.js b/new/name.js
similarity index 95%
rename from old/name.js
rename to new/name.js
--- a/old/name.js
+++ b/new/name.js
@@ -1 +1 @@
-const a = 1
+const a = 2
diff --git a/logo.png b/logo.png
index 333..444 100644
Binary files a/logo.png and b/logo.png differ
diff --git a/src/added.js b/src/added.js
new file mode 100644
--- /dev/null
+++ b/src/added.js
@@ -0,0 +1,2 @@
+export const a = 1
+export const b = 2
diff --git a/src/gone.js b/src/gone.js
deleted file mode 100644
--- a/src/gone.js
+++ /dev/null
@@ -1 +0,0 @@
-export const gone = true
`

test("parseDiff handles modified, renamed, binary, added and deleted files", () => {
  const files = parseDiff(DIFF)
  assert.equal(files.length, 5)
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]))
  assert.ok(byPath["src/pay.js"].diff.includes("@@"))
  assert.equal(byPath["new/name.js"].renamed, true)
  assert.equal(byPath["new/name.js"].oldPath, "old/name.js")
  assert.equal(byPath["logo.png"].binary, true)
  assert.equal(byPath["logo.png"].diff, "")
  assert.equal(byPath["src/added.js"].newFile, true)
  assert.equal(byPath["src/gone.js"].deleted, true)
})

test("changedLines maps added lines to new-side numbers", () => {
  const f = parseDiff(DIFF).find((x) => x.path === "src/added.js")
  assert.deepEqual(changedLines(f.diff), [1, 2])
})

test("classify separates the triage surfaces", () => {
  assert.equal(classify("src/pay.js"), SURFACE.SOURCE)
  assert.equal(classify("db/migrations/001_drop.sql"), SURFACE.MIGRATION)
  assert.equal(classify("package.json"), SURFACE.MANIFEST)
  assert.equal(classify("src/pay.test.js"), SURFACE.TESTS)
  assert.equal(classify("src/__tests__/x.js"), SURFACE.TESTS)
  assert.equal(classify("README.md"), SURFACE.NON_CODE)
  assert.equal(classify("docs/guide.md"), SURFACE.NON_CODE)
  assert.equal(classify("Dockerfile"), SURFACE.CONFIG)
  assert.equal(classify(".github/workflows/ci.yml"), SURFACE.CONFIG)
})

test("risk categories reflect what the path implies", () => {
  assert.ok(risksFor("src/auth/login.js", SURFACE.SOURCE).has(RISK.SECURITY))
  assert.ok(risksFor("db/migrations/1.sql", SURFACE.MIGRATION).has(RISK.DATA))
  assert.ok(risksFor("src/api/orders.js", SURFACE.SOURCE).has(RISK.CONTRACT))
  assert.ok(risksFor("src/worker/queue.js", SURFACE.SOURCE).has(RISK.CONCURRENCY))
  assert.equal(risksFor("README.md", SURFACE.NON_CODE).size, 0)
  assert.deepEqual([...risksFor("a.test.js", SURFACE.TESTS)], [RISK.TESTS])
})

test("cells are derived deterministically and high-risk ones are mandatory", () => {
  const files = [{ path: "db/migrations/1.sql" }, { path: "src/pay.js" }]
  const cells = deriveCells(files)
  const ids = cells.map((c) => c.id)
  assert.deepEqual(ids, [...ids].sort(), "cells must be in stable order")
  assert.ok(ids.includes("migration:data"))
  assert.equal(cells.find((c) => c.id === "migration:data").mandatory, true)
  assert.equal(isHighRisk(cells), true)
})

test("a docs-only diff is trivial and yields no cells", () => {
  const files = [{ path: "README.md" }, { path: "docs/x.md" }]
  assert.equal(isTrivial(files), true)
  assert.deepEqual(deriveCells(files), [])
  assert.equal(isTrivial([{ path: "README.md" }, { path: "src/a.js" }]), false)
})

test("fnmatch follows whole-string semantics with * crossing separators", () => {
  assert.ok(fnmatch("src/a/b.js", "*.js"))
  assert.ok(fnmatch("src/db/model.rb", "*db*"))
  assert.ok(!fnmatch("src/a.js", "*.ts"))
  assert.ok(fnmatch("a.js", "a.?s"))
  assert.ok(!fnmatch("prefix/a.js", "a.js"))
})

const YAML = `
instructions:
  - name: Database rules
    instructions: |
      Every migration must be reversible.
      Name the rollback path.
    fileFilters:
      - "db/**"
      - "*.sql"
      - "!db/seeds/*"
  - name: API rules
    instructions: Version every breaking response change.
    fileFilters:
      - "src/api/*"
`

test("the bounded YAML parser reads the one documented shape", () => {
  const items = parseInstructionsYaml(YAML)
  assert.equal(items.length, 2)
  assert.equal(items[0].name, "Database rules")
  assert.match(items[0].instructions, /reversible/)
  assert.match(items[0].instructions, /rollback path/)
  assert.deepEqual(items[0].fileFilters, ["db/**", "*.sql", "!db/seeds/*"])
  assert.equal(items[1].instructions, "Version every breaking response change.")
})

test("the YAML parser ignores what it does not recognise rather than guessing", () => {
  const items = parseInstructionsYaml(`
version: 2
weird: { nested: { deeply: true } }
instructions:
  - name: Only valid one
    instructions: text
    fileFilters: ["*.js"]
  - name: Missing filters
    instructions: text
`)
  assert.equal(items.length, 1)
  assert.equal(items[0].name, "Only valid one")
  assert.deepEqual(items[0].fileFilters, ["*.js"])
})

test("instruction selection applies positive globs then exclusions", () => {
  const ins = {
    name: "db", text: "t",
    include: ["db/**", "*.sql"],
    exclude: ["db/seeds/*"],
  }
  assert.equal(instructionMatches("db/migrations/1.sql", ins), true)
  assert.equal(instructionMatches("db/seeds/dev.sql", ins), false)
  assert.equal(instructionMatches("src/a.js", ins), false)
  const selected = selectInstructions([ins], ["db/migrations/1.sql", "src/a.js"])
  assert.equal(selected.length, 1)
  assert.deepEqual(selected[0].files, ["db/migrations/1.sql"])
})

test("instructions that match nothing are not attached at all", () => {
  const ins = { name: "db", text: "t", include: ["db/**"], exclude: [] }
  assert.deepEqual(selectInstructions([ins], ["src/a.js"]), [])
})

test("diffHash is stable across calls and sensitive to any change", () => {
  assert.equal(diffHash(DIFF), diffHash(DIFF))
  assert.notEqual(diffHash(DIFF), diffHash(DIFF + "\n"))
})

const ctxFor = (extra = {}) => ({
  target: "uncommitted",
  diffHash: "abc123",
  cells: deriveCells([{ path: "src/pay.js" }]),
  instructions: [],
  files: parseDiff(DIFF),
  originals: {},
  ...extra,
})

test("the static prefix is byte-identical across builds regardless of input ordering", () => {
  const a = buildStaticPrefix(ctxFor())
  const shuffled = ctxFor()
  shuffled.files = [...shuffled.files].reverse()
  shuffled.cells = [...shuffled.cells].reverse()
  assert.equal(buildStaticPrefix(shuffled), a, "prefix must not depend on input order")
})

test("the static prefix carries the diff and the cells, and marks mandatory ones", () => {
  const cells = deriveCells([{ path: "db/migrations/1.sql" }])
  const prefix = buildStaticPrefix(ctxFor({ cells }))
  assert.match(prefix, /<coverage_cells>/)
  assert.match(prefix, /migration:data" mandatory="true"/)
  assert.match(prefix, /<file_diff filename="src\/pay\.js">/)
  assert.match(prefix, /renamed_from="old\/name\.js"/)
  assert.match(prefix, /\(binary file/)
})

test("custom instructions appear in the prefix flagged as advisory only", () => {
  const prefix = buildStaticPrefix(ctxFor({
    instructions: [{ name: "db", text: "reversible only", files: ["db/1.sql"], include: [], exclude: [] }],
  }))
  assert.match(prefix, /<custom_instructions>/)
  assert.match(prefix, /Advisory only/)
  assert.match(prefix, /reversible only/)
})

test("a malformed inline fileFilters list is rejected, not half-parsed", () => {
  const items = parseInstructionsYaml(`
instructions:
  - name: Broken
    instructions: text
    fileFilters: "*.js", "*.ts"
  - name: Fine
    instructions: text
    fileFilters: ["*.md"]
`)
  assert.deepEqual(items.map((i) => i.name), ["Fine"])
})

test("items nested under an unrelated key are not treated as policy", () => {
  const items = parseInstructionsYaml(`
other:
  - name: Not an instruction
    instructions: should be ignored
    fileFilters: ["*"]
instructions:
  - name: Real
    instructions: text
    fileFilters: ["*.js"]
`)
  assert.deepEqual(items.map((i) => i.name), ["Real"])
})

test("a folded scalar joins its lines, a literal scalar keeps them", () => {
  const [folded] = parseInstructionsYaml(`
instructions:
  - name: F
    instructions: >
      one
      two
    fileFilters: ["*"]
`)
  assert.equal(folded.instructions, "one two")
  const [literal] = parseInstructionsYaml(`
instructions:
  - name: L
    instructions: |
      one
      two
    fileFilters: ["*"]
`)
  assert.equal(literal.instructions, "one\ntwo")
})

test("instruction items nested deeper than the list itself are ignored", () => {
  const items = parseInstructionsYaml(`
instructions:
  wrapper:
    - name: Smuggled
      instructions: should not be policy
      fileFilters: ["*"]
  - name: Real
    instructions: text
    fileFilters: ["*.js"]
`)
  assert.deepEqual(items.map((i) => i.name), ["Real"])
})

test("cells record the lines the diff actually touches", () => {
  const files = parseDiff(DIFF)
  const cells = deriveCells(files)
  const src = cells.find((c) => c.id === "source:correctness")
  assert.ok(src.lines["src/pay.js"]?.length, "changed lines must be recorded for anchor checking")
})

test("a binary file offers no inspectable lines, so no line anchor is valid for it", () => {
  const cells = deriveCells(parseDiff(DIFF))
  const asset = cells.find((c) => (c.files ?? []).includes("logo.png"))
  if (asset) assert.equal(asset.maxLine["logo.png"], 0)
})

test("cells carry a line bound for every file they cover", () => {
  const cells = deriveCells(parseDiff(DIFF))
  for (const cell of cells) {
    for (const file of cell.files) {
      assert.ok(cell.maxLine[file] !== undefined, `${cell.id} has no bound for ${file}`)
    }
  }
})

test("git C-quoted paths are decoded, not dropped", () => {
  const quoted = `diff --git "a/src/we\\tird.js" "b/src/we\\tird.js"
index 111..222 100644
--- "a/src/we\\tird.js"
+++ "b/src/we\\tird.js"
@@ -1 +1 @@
-const a = 1
+const a = 2
`
  const files = parseDiff(quoted)
  assert.equal(files.length, 1)
  assert.equal(files[0].path, "src/we\tird.js", "a quoted path must resolve, not vanish")
})

test("a metadata-only change stays visible but yields no coverage cell", () => {
  const renameOnly = `diff --git a/old.js b/new.js
similarity index 100%
rename from old.js
rename to new.js
`
  const files = parseDiff(renameOnly)
  assert.equal(files.length, 1)
  assert.equal(files[0].path, "new.js")
  assert.deepEqual(deriveCells(files), [], "nothing to anchor evidence against")
  const prefix = buildStaticPrefix({
    target: "t", diffHash: "h", cells: [], instructions: [], files, originals: {},
  })
  assert.match(prefix, /new\.js/)
  assert.match(prefix, /no content change/)
})

test("octal escapes decode as UTF-8 bytes, not independent code units", () => {
  const cyrillic = `diff --git "a/src/\\320\\220.js" "b/src/\\320\\220.js"
--- "a/src/\\320\\220.js"
+++ "b/src/\\320\\220.js"
@@ -1 +1 @@
-a
+b
`
  assert.equal(parseDiff(cyrillic)[0].path, "src/А.js")
})

test("a real path beginning with a/ or b/ is not truncated by a rename", () => {
  const renamed = `diff --git a/a/old.js b/b/new.js
similarity index 100%
rename from a/old.js
rename to b/new.js
`
  const [f] = parseDiff(renamed)
  assert.equal(f.oldPath, "a/old.js")
  assert.equal(f.path, "b/new.js")
})

test("YAML instructions must be plain string scalars", () => {
  const items = parseInstructionsYaml(`
instructions:
  - name: null
    instructions: text
    fileFilters: ["*.js"]
  - name: Flow value
    instructions: {a: 1}
    fileFilters: ["*.js"]
  - name: Bad filters
    instructions: text
    fileFilters: [true, "*.js"]
  - name: Good
    instructions: text
    fileFilters: ["*.js"]
`)
  assert.deepEqual(items.map((i) => i.name), ["Good"])
})

test("a metadata-only change to a high-risk path is not trivial", () => {
  const renamedAuth = [{ path: "src/auth/guard.js", diff: "", renamed: true, oldPath: "src/auth/old.js" }]
  assert.equal(isTrivial(renamedAuth), false, "renaming an auth module is a reviewable change")
  assert.equal(touchesHighRisk(renamedAuth), true, "and it must draw the high-risk pass minimum")
})

test("a malformed quoted path fails instead of crashing", () => {
  const trailing = `diff --git "a/src/bad\\" "b/src/bad\\"
--- "a/src/bad\\"
+++ "b/src/bad\\"
@@ -1 +1 @@
-a
+b
`
  assert.doesNotThrow(() => parseDiff(trailing))
})
