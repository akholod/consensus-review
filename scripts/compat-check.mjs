#!/usr/bin/env node
// Release gate: prove the live CLI still returns the envelope shape the adapter parses.
// Deliberately NOT part of CI — it needs auth, network and billing. Run it before a release
// and paste the result into docs/RELEASING.md.
//
// The probe itself lives in scripts/lib/probe.mjs, shared with scripts/doctor.mjs, so the check
// that gates a release and the check a user runs cannot drift apart.
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { probeClaude } from "./lib/probe.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim()
console.log(`claude CLI: ${version}`)

const probe = probeClaude({ root: ROOT })

let failed = 0
for (const [label, ok] of probe.checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`)
  if (!ok) failed++
}
if (!probe.ok) console.error(`state=${probe.state} detail=${probe.detail}`)
console.log(failed ? `\n${failed} check(s) failed — do not release.` : `\nAll checks passed against ${version}.`)
process.exit(failed ? 1 : 0)
