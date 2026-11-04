import { test } from "node:test"
import assert from "node:assert/strict"
import { checkCitation, newSideLines, safePath } from "../../scripts/lib/quote-check.mjs"

// src/auth.js new side: lines 10..14; lines 11 and 12 are added.
const DIFF = `diff --git a/src/auth.js b/src/auth.js
index 1111111..2222222 100644
--- a/src/auth.js
+++ b/src/auth.js
@@ -10,3 +10,5 @@ function login(user) {
   const token = read(user)
+  if (!token) throw new Error("no token")
+  assertNotExpired(token, now())
   return token
 }
diff --git a/old/name.js b/new/name.js
similarity 90%
rename from old/name.js
rename to new/name.js
--- a/old/name.js
+++ b/new/name.js
@@ -1,2 +1,2 @@
-export const renamedValue = 1
+export const renamedValue = 2
 export const other = 3
diff --git a/gone.js b/gone.js
deleted file mode 100644
index 3333333..0000000
--- a/gone.js
+++ /dev/null
@@ -1,1 +0,0 @@
-export const deletedGuard = true
`

// A head file of 40 lines with the guard at line 20.
const HEAD = Array.from({ length: 40 }, (_, i) => (i === 19 ? "  if (!isAdmin(user)) return deny()" : `line ${i + 1}`)).join("\n")
const reader = (files) => (path) => files[path] ?? null

const check = (citation, readHeadFile = null) => checkCitation({ citation, diffText: DIFF, readHeadFile })
const ok = (r, source) => assert.deepEqual(r, { verified: true, reason: null, source })
const no = (r, reason) => {
  assert.equal(r.verified, false)
  assert.equal(r.reason, reason)
  assert.equal(r.source, null)
}

test("newSideLines: + and context lines at new-side numbers; renamed by new path; deleted has none", () => {
  const lines = newSideLines(DIFF, "src/auth.js")
  assert.deepEqual([...lines.keys()].slice(0, 5), [10, 11, 12, 13, 14])
  assert.equal(lines.get(11), '  if (!token) throw new Error("no token")')
  assert.ok(newSideLines(DIFF, "new/name.js").get(1).includes("renamedValue = 2"))
  assert.equal(newSideLines(DIFF, "old/name.js"), null)
  assert.equal(newSideLines(DIFF, "gone.js"), null)
  assert.equal(newSideLines(DIFF, "missing.js"), null)
})

test("verifies: exact, whitespace-only difference, ±5 drift, multi-line on the diff's new side", () => {
  ok(check({ file: "src/auth.js", line: "11", quote: 'if (!token) throw new Error("no token")' }), "diff")
  ok(check({ file: "src/auth.js", line: 11, quote: '   if  (!token)\tthrow new Error("no token")  ' }), "diff")
  ok(check({ file: "src/auth.js", line: "L16-18", quote: 'if (!token) throw new Error("no token")' }), "diff")
  ok(check({ file: "src/auth.js", line: "6", quote: 'if (!token) throw new Error("no token")' }), "diff")
  ok(check({ file: "src/auth.js", line: "11", quote: 'if (!token) throw new Error("no token")\n  assertNotExpired(token, now())' }), "diff")
  ok(check({ file: "new/name.js", line: "1", quote: "export const renamedValue = 2" }), "diff")
})

test("verifies a file outside the diff through readHeadFile, with drift", () => {
  const read = reader({ "src/guard.js": HEAD })
  ok(check({ file: "src/guard.js", line: "20", quote: "if (!isAdmin(user)) return deny()" }, read), "head")
  ok(check({ file: "src/guard.js", line: "25", quote: "if (!isAdmin(user)) return deny()" }, read), "head")
  ok(check({ file: "src/guard.js", line: "15", quote: "if (!isAdmin(user)) return deny()" }, read), "head")
})

test("fails with a reason, never throws", () => {
  const quote = 'if (!token) throw new Error("no token")'
  no(check({ file: "src/auth.js", line: "17", quote }), "quote not found in diff")
  no(check({ file: "src/auth.js", line: "5", quote }), "quote not found in diff")
  no(check({ file: "src/guard.js", line: "26", quote: "if (!isAdmin(user)) return deny()" }, reader({ "src/guard.js": HEAD })), "quote not found")
  no(check({ file: "src/guard.js", line: "14", quote: "if (!isAdmin(user)) return deny()" }, reader({ "src/guard.js": HEAD })), "quote not found")
  no(check({ file: "src/auth.js", line: "11", quote: 'if (!Token) throw new Error("no token")' }), "quote not found in diff")
  no(check({ file: "src/auth.js", line: "11", quote: "if (!token) throw ... no token" }), "elided quote")
  no(check({ file: "src/auth.js", line: "11", quote: "if (!token) throw … no token" }), "elided quote")
  no(check({ file: "src/auth.js", line: "11", quote: " if (! tok " }), "quote too short")
  no(check({ file: "src/auth.js", line: "11", quote: "x".repeat(2001) }), "quote too long")
  no(check({ file: "src/auth.js", line: "near the top", quote }), "line without number")
  no(check({ file: "src/guard.js", line: "20", quote: "if (!isAdmin(user)) return deny()" }), "cannot verify outside diff")
  no(check({ file: "src/guard.js", line: "20", quote: "if (!isAdmin(user)) return deny()" }, reader({})), "file not readable at head")
  for (const bad of [null, "src/auth.js:11", { file: "src/auth.js", line: { n: 11 }, quote }, { line: "11", quote }]) {
    no(check(bad), "malformed citation")
  }
  no(check({ file: "x.js", line: "1", quote }, () => { throw new Error("boom") }), "check failed")
})

test("a deleted file's diff lines are not matched; it falls through to readHeadFile", () => {
  no(check({ file: "gone.js", line: "1", quote: "export const deletedGuard = true" }), "cannot verify outside diff")
  no(check({ file: "gone.js", line: "1", quote: "export const deletedGuard = true" }, reader({})), "file not readable at head")
})

test("paths './x', '../x', 'a/../x' and absolute are rejected before any read", () => {
  let reads = 0
  const read = () => { reads++; return HEAD }
  for (const file of ["./src/guard.js", "../src/guard.js", "src/../guard.js", "/etc/passwd"]) {
    no(check({ file, line: "20", quote: "if (!isAdmin(user)) return deny()" }, read), "unsafe path")
  }
  assert.equal(reads, 0)
  assert.equal(safePath("a..b/c.js"), true)
})
