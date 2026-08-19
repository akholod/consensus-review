#!/usr/bin/env node
// Release gate: prove the live CLI still returns the envelope shape the adapter parses.
// Deliberately NOT part of CI — it needs auth, network and billing. Run it before a release
// and paste the result into docs/RELEASING.md.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { run } from "../src/loop-review/adapter.mjs"
import { PASS_STATE_OK } from "../src/loop-review/schema.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim()
console.log(`claude CLI: ${version}`)

// Probe with a REAL review task, using the production discovery prompt and a tiny diff.
//
// The original probe just asked for a canned `{"findings":[],"cells":[]}` with no code attached.
// Against CLI 2.1.235 the model refused it — correctly, since that is a request to fabricate a
// clean verdict for a review it was never given. The adapter classified the refusal properly, so
// nothing was wrong with the adapter; the probe was simply not asking for anything real, and a
// gate that does not exercise the production path cannot vouch for it.
const DIFF = `diff --git a/src/take.js b/src/take.js
index 1111111..2222222 100644
--- a/src/take.js
+++ b/src/take.js
@@ -1,3 +1,3 @@
 export function take(xs, n) {
-  return xs.slice(0, Math.min(n, xs.length))
+  return xs.slice(0, n + 1)
 }`

const prompt = [
  "<diff>", DIFF, "</diff>",
  "<cells>", '<cell id="source:correctness" mandatory="false">src/take.js</cell>', "</cells>",
  readFileSync(join(ROOT, "prompts/loop-review/discovery.md"), "utf8"),
].join("\n\n")

const result = run({ prompt, timeoutMs: 180_000 })

const checks = [
  ["envelope parsed and payload extracted", result.state === PASS_STATE_OK],
  ["findings array present", Array.isArray(result.payload?.findings)],
  ["cells array present", Array.isArray(result.payload?.cells)],
  ["usage.input_tokens present", typeof result.usage.input_tokens === "number"],
  ["usage.cache_read_input_tokens present", typeof result.usage.cache_read_input_tokens === "number"],
  ["cost reported", typeof result.usage.cost_usd === "number"],
]

let failed = 0
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`)
  if (!ok) failed++
}
if (result.state !== PASS_STATE_OK) console.error(`state=${result.state} detail=${result.detail}`)
console.log(failed ? `\n${failed} check(s) failed — do not release.` : `\nAll checks passed against ${version}.`)
process.exit(failed ? 1 : 0)
