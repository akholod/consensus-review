#!/usr/bin/env node
// Release gate: prove the live CLI still returns the envelope shape the adapter parses.
// Deliberately NOT part of CI — it needs auth, network and billing. Run it before a release
// and paste the result into docs/RELEASING.md.
import { execFileSync } from "node:child_process"
import { run } from "../src/loop-review/adapter.mjs"
import { PASS_STATE_OK } from "../src/loop-review/schema.mjs"

const version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim()
console.log(`claude CLI: ${version}`)

const result = run({
  prompt: 'Respond with ONLY this JSON object and nothing else: {"findings":[],"cells":[]}',
  timeoutMs: 180_000,
})

const checks = [
  ["envelope parsed and payload extracted", result.state === PASS_STATE_OK],
  ["findings array present", Array.isArray(result.payload?.findings)],
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
