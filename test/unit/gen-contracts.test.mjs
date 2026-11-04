import { test } from "node:test"
import assert from "node:assert/strict"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { renderSketch } from "../../scripts/lib/sketch.mjs"
import { projectionProblems } from "../../scripts/gen-contracts.mjs"
import { resolveRef } from "../../scripts/lib/json-schema.mjs"

const LOOP = JSON.parse(readFileSync("contracts/loop-payload.schema.json", "utf8"))
const FINDING = JSON.parse(readFileSync("contracts/finding.schema.json", "utf8"))
const consensusItems = resolveRef(FINDING, "#/properties/findings/items")
const loopFinding = resolveRef(LOOP, "#/$defs/loopFinding")
const clone = (v) => JSON.parse(JSON.stringify(v))

// ---------------------------------------------------------------------------------------------
// The projection check
// ---------------------------------------------------------------------------------------------

test("the repository's projection is clean", () => {
  assert.deepEqual(projectionProblems(consensusItems, loopFinding, LOOP["x-projection"]), [])
})

test("an undeclared dropped field fails", () => {
  const loop = clone(loopFinding)
  delete loop.properties.confidence
  loop.required = loop.required.filter((k) => k !== "confidence")
  const problems = projectionProblems(consensusItems, loop, LOOP["x-projection"])
  assert.match(problems.join("\n"), /drops "confidence" without declaring it/)
})

test("a widened type on a shared field fails", () => {
  const loop = clone(loopFinding)
  loop.properties.line = { type: ["string", "number", "null"] }
  assert.match(
    projectionProblems(consensusItems, loop, LOOP["x-projection"]).join("\n"),
    /"line" differs from the consensus contract/
  )
})

test("an enum that gains a member on a shared field fails", () => {
  const loop = clone(loopFinding)
  loop.properties.severity = { type: "string", enum: ["P0", "P1", "P2", "P3"] }
  assert.match(
    projectionProblems(consensusItems, loop, LOOP["x-projection"]).join("\n"),
    /"severity" differs from the consensus contract/
  )
})

test("a field the consensus contract does not have fails", () => {
  const loop = clone(loopFinding)
  loop.properties.invented = { type: "string" }
  loop.required.push("invented")
  assert.match(
    projectionProblems(consensusItems, loop, LOOP["x-projection"]).join("\n"),
    /adds "invented"/
  )
})

test("re-adding a declared omission fails", () => {
  const loop = clone(loopFinding)
  loop.properties.owner = consensusItems.properties.owner
  assert.match(
    projectionProblems(consensusItems, loop, LOOP["x-projection"]).join("\n"),
    /"owner" is declared an omission but is present/
  )
})

test("declaring an omission that does not exist upstream fails", () => {
  const projection = { ...LOOP["x-projection"], omissions: ["dimension", "owner", "ghost"] }
  assert.match(
    projectionProblems(consensusItems, loopFinding, projection).join("\n"),
    /names "ghost", which the consensus contract does not have/
  )
})

test("a required flag dropped on a kept field fails", () => {
  const loop = clone(loopFinding)
  loop.required = loop.required.filter((k) => k !== "line")
  assert.match(projectionProblems(consensusItems, loop, LOOP["x-projection"]).join("\n"), /required omits line/)
})

// ---------------------------------------------------------------------------------------------
// The sketch renderer. The load-bearing property is that it reproduces what the prompts already
// said, so adopting generation did not silently change what the model is asked for.
// ---------------------------------------------------------------------------------------------

test("the discovery sketch is byte-identical to the block in the prompt", () => {
  const prompt = readFileSync("prompts/loop-review/discovery.md", "utf8")
  const rendered = renderSketch(LOOP, "#/$defs/discoveryPayload")
  assert.ok(prompt.includes(rendered), "the generated discovery sketch is not present in the prompt verbatim")
})

test("the verifier sketch is byte-identical to the block in the prompt", () => {
  const prompt = readFileSync("prompts/loop-review/verify.md", "utf8")
  const rendered = renderSketch(LOOP, "#/$defs/verifierPayload")
  assert.ok(prompt.includes(rendered), "the generated verifier sketch is not present in the prompt verbatim")
})

test("the sketch shows the INTENDED contract, never the runtime's tolerance", () => {
  // The runtime accepts a number for `line`, but telling the model that would be a behaviour
  // change for the worse. The prompt must ask for the narrow contract.
  const rendered = renderSketch(LOOP, "#/$defs/discoveryPayload")
  assert.match(rendered, /"line": str\|null/)
  assert.doesNotMatch(rendered, /"line": [^\n]*num/)
})

test("enums render as alternations and scalars as type names", () => {
  const root = {
    $defs: {
      p: {
        type: "object",
        properties: {
          a: { type: "string" },
          b: { type: "boolean" },
          c: { type: ["string", "null"] },
          d: { type: "string", enum: ["x", "y"] },
          e: { type: ["string", "null"], enum: ["x", null] },
          f: { type: "array", items: { type: "string" } },
        },
      },
    },
  }
  // Top-level arrays are expanded onto their own lines on purpose: that is what reproduces the
  // shape the prompts were hand-written in.
  assert.equal(
    renderSketch(root, "#/$defs/p"),
    [
      "{",
      '  "a": str,',
      '  "b": bool,',
      '  "c": str|null,',
      '  "d": "x"|"y",',
      '  "e": "x"|null,',
      '  "f": [',
      "    str",
      "  ]",
      "}",
    ].join("\n")
  )
})

test("a long object body wraps at property boundaries, never mid-property", () => {
  const rendered = renderSketch(LOOP, "#/$defs/discoveryPayload")
  for (const line of rendered.split("\n")) {
    assert.ok(line.length <= 100, `line too long: ${line}`)
    // A wrapped continuation must start a property, not split one.
    if (/^\s+"/.test(line) === false) continue
    assert.doesNotMatch(line, /:\s*$/, `property left dangling: ${line}`)
  }
})

// ---------------------------------------------------------------------------------------------
// The CLI contract
// ---------------------------------------------------------------------------------------------

test("--check passes on the committed tree", () => {
  const out = execFileSync("node", ["scripts/gen-contracts.mjs", "--check"], { encoding: "utf8" })
  assert.match(out, /in sync \(5 generated blocks, projection verified\)/)
})

test("--check fails when a generated block is edited by hand", () => {
  const path = "prompts/loop-review/verify.md"
  const original = readFileSync(path, "utf8")
  try {
    execFileSync("node", ["-e", `
      const fs = require("fs")
      fs.writeFileSync(${JSON.stringify(path)}, fs.readFileSync(${JSON.stringify(path)}, "utf8")
        .replace('"verified": bool', '"verified": str'))
    `])
    assert.throws(
      () => execFileSync("node", ["scripts/gen-contracts.mjs", "--check"], { encoding: "utf8", stdio: "pipe" }),
      /OUT OF SYNC/
    )
  } finally {
    execFileSync("node", ["-e", `require("fs").writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(original)})`])
  }
  assert.equal(readFileSync(path, "utf8"), original, "the test must leave the tree as it found it")
})

/** Run `--check` on a copy of the repo after `mutate(path)`; returns the error output, or null on success. */
function checkCopy(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "gen-contracts-"))
  try {
    for (const part of ["agents", "commands", "contracts", "prompts"]) cpSync(part, join(dir, part), { recursive: true })
    mutate((rel) => join(dir, rel))
    execFileSync("node", ["scripts/gen-contracts.mjs", "--check", "--dir", dir], { encoding: "utf8", stdio: "pipe" })
    return null
  } catch (err) {
    return String(err.stderr ?? err.message)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const editCopy = (path, rel, from, to) => {
  const text = readFileSync(path(rel), "utf8")
  assert.ok(text.includes(from), `${rel} must contain ${from}`)
  writeFileSync(path(rel), text.replace(from, to))
}

test("--check passes on an unmodified copy", () => {
  assert.equal(checkCopy(() => {}), null)
})

for (const rel of ["agents/finding-verifier.md", "commands/consensus-review.md"]) {
  test(`--check fails when the vote block in ${rel} is edited by hand`, () => {
    const err = checkCopy((path) => editCopy(path, rel, '"quote": str}|null', '"quote": str}'))
    assert.match(err ?? "", new RegExp(`${rel} is OUT OF SYNC with contracts/verdict.schema.json`))
  })
}

test("a vote schema whose citation allows extra properties is rejected", () => {
  const err = checkCopy((path) => {
    const schema = JSON.parse(readFileSync(path("contracts/verdict.schema.json"), "utf8"))
    delete schema.properties.verdicts.items.properties.citation.additionalProperties
    writeFileSync(path("contracts/verdict.schema.json"), JSON.stringify(schema, null, 2))
  })
  assert.match(err ?? "", /citation: missing "additionalProperties": false/)
})

test("a nullable object renders as its body followed by |null", () => {
  const VERDICT = JSON.parse(readFileSync("contracts/verdict.schema.json", "utf8"))
  const rendered = renderSketch(VERDICT, "#/properties/verdicts/items")
  assert.match(rendered, /^  "citation": \{"file": str, "line": str, "quote": str\}\|null,$/m)
})
