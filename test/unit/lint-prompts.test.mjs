// Both directions matter. Sensitivity alone would pass a lint that reddens on everything, so every
// check has mutations that MUST go red and benign controls that MUST stay green. The benign half is
// what stops the lint ossifying prompt wording, and it is where the real bugs were: matching bare
// tokens flagged `agents/impact-reviewer.md`'s prose "(Original P3 collapses here.)" as drift, and
// requiring `subagent_type:` reported the live `finding-verifier` as orphaned.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { lint, parseFrontmatter, vocabulary } from "../../scripts/lint-prompts.mjs"

/** Copy the parts of the repo the lint reads, apply `mutate`, and lint the copy. */
function lintWith(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "lint-"))
  try {
    for (const part of ["agents", "commands", "contracts"]) cpSync(part, join(dir, part), { recursive: true })
    const edit = (rel, fn) => {
      const path = join(dir, rel)
      writeFileSync(path, fn(readFileSync(path, "utf8")))
    }
    mutate({ dir, edit, path: (rel) => join(dir, rel) })
    return lint(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const messages = (problems) => problems.map((p) => `${p.file}:${p.line}: ${p.message}`).join("\n")

const red = (label, mutate, match) => test(`RED — ${label}`, () => {
  const problems = lintWith(mutate)
  assert.ok(problems.length > 0, `${label} should have been caught`)
  assert.match(messages(problems), match)
})

const green = (label, mutate) => test(`GREEN — ${label}`, () => {
  const problems = lintWith(mutate)
  assert.deepEqual(problems, [], `${label} must not trip the lint:\n${messages(problems)}`)
})

// -------------------------------------------------------------------------------------------
// The tree as it stands must be clean, or none of the rest means anything.
// -------------------------------------------------------------------------------------------

test("the repository is clean", () => {
  assert.deepEqual(lint(process.cwd()), [])
})

// -------------------------------------------------------------------------------------------
// L1 — frontmatter
// -------------------------------------------------------------------------------------------

red("L1: frontmatter key removed",
  ({ edit }) => edit("agents/impact-reviewer.md", (t) => t.replace(/^model: .*$/m, "")),
  /L1: frontmatter is missing `model`/)

red("L1: name no longer matches the filename",
  ({ edit }) => edit("agents/impact-reviewer.md", (t) => t.replace("name: impact-reviewer", "name: impact-review")),
  /L1: frontmatter name `impact-review` does not match the filename/)

red("L1: frontmatter is unterminated",
  ({ edit }) => edit("agents/quality-reviewer.md", (t) => t.replace(/^---\n/, "")),
  /L1: no terminated/)

green("L1: frontmatter written with different spacing",
  ({ edit }) => edit("agents/impact-reviewer.md", (t) => t.replace("model: opus", "model:   opus")))

// -------------------------------------------------------------------------------------------
// L2 — the read-only guarantee. The load-bearing check.
// -------------------------------------------------------------------------------------------

red("L2: disallowedTools removed entirely",
  ({ edit }) => edit("agents/arch-reviewer.md", (t) => t.replace(/^disallowedTools: .*$/m, "")),
  /L2: review agent has no `disallowedTools`/)

red("L2: Write quietly dropped from disallowedTools",
  ({ edit }) => edit("agents/arch-reviewer.md", (t) => t.replace("disallowedTools: Write, Edit", "disallowedTools: Edit")),
  /L2: `disallowedTools` no longer denies `Write`/)

red("L2: Edit quietly dropped from disallowedTools",
  ({ edit }) => edit("agents/finding-verifier.md", (t) => t.replace("disallowedTools: Write, Edit", "disallowedTools: Write")),
  /L2: `disallowedTools` no longer denies `Edit`/)

green("L2: disallowedTools reordered and respaced",
  ({ edit }) => edit("agents/arch-reviewer.md", (t) => t.replace("disallowedTools: Write, Edit", "disallowedTools: Edit,Write")))

// -------------------------------------------------------------------------------------------
// L5a — contracted vocabulary must still be present (catches deletion)
// -------------------------------------------------------------------------------------------

red("L5a: a contracted severity deleted from an agent's vocabulary",
  ({ edit }) => edit("agents/test-reviewer.md", (t) => t.replace(/`P2`/g, "medium")),
  /L5a: agent no longer names the contracted severity `P2`/)

// -------------------------------------------------------------------------------------------
// L5b — nothing outside the contract (catches addition)
// -------------------------------------------------------------------------------------------

red("L5b: an invented severity in an agent's output vocabulary",
  ({ edit }) => edit("agents/quality-reviewer.md", (t) => t.replace("`P2`", "`P4`")),
  /L5b: `P4` is not a severity/)

red("L5b: an invented severity hidden inside a backticked JSON template",
  ({ edit }) => edit("agents/finding-verifier.md", (t) => `${t}\n\n\`"suggested_severity": "P0|P1|P2|P3|null"\`\n`),
  /L5b: `P3` is not a severity/)

// L5c — the verifier's vote shape is generated; the lint only requires the block to be there.
red("L5c: the generated vote block removed from the verifier",
  ({ edit }) => edit("agents/finding-verifier.md", (t) =>
    t.replace(/<!-- BEGIN GENERATED: contracts\/verdict\.schema\.json[\s\S]*?<!-- END GENERATED -->\n/, "")),
  /L5c: no `<!-- BEGIN GENERATED: contracts\/verdict\.schema\.json` block/)

test("the real agents/finding-verifier.md passes, severities included", () => {
  // Its only backticked severities are the prose line about `suggested_severity`: the generated
  // block is fenced, which vocabulary() does not read.
  assert.deepEqual(lint(process.cwd()).filter((p) => p.file === "agents/finding-verifier.md"), [])
})

red("L5a: the verifier's prose line about suggested_severity removed",
  ({ edit }) => edit("agents/finding-verifier.md", (t) => t.replace(/^.*`suggested_severity` is `P0`.*\n/m, "")),
  /agents\/finding-verifier\.md:1: L5a: agent no longer names the contracted severity `P0`/)

green("L5b: a severity named only in prose, never in the output vocabulary",
  // This is the exact false positive that scoping to backticks exists to avoid. It is a regression
  // test, not a nicety: `agents/impact-reviewer.md:62` already reads "(Original P3 collapses here.)"
  ({ edit }) => edit("agents/quality-reviewer.md", (t) => `${t}\n\nHistorically P3 and P4 collapsed into P2.\n`))

green("prose rewritten around an unchanged contract",
  ({ edit }) => edit("agents/impact-reviewer.md", (t) =>
    t.replace(/^You are a reviewer.*$/m, "You review the change and what it touches.")))

green("an extra unrelated fenced block added",
  ({ edit }) => edit("agents/test-reviewer.md", (t) => `${t}\n\n\`\`\`\n{"example": "not a contract"}\n\`\`\`\n`))

// -------------------------------------------------------------------------------------------
// L6 — dispatch integrity
// -------------------------------------------------------------------------------------------

red("L6: a subagent_type pointing at no agent",
  ({ edit }) => edit("commands/impact-review.md", (t) => t.replace(/impact-reviewer/g, "impact-inspector")),
  /L6: dispatches `impact-inspector`, which does not exist/)

red("L6: an agent no command references any more",
  // Added as a new file rather than renaming a live one: renaming trips L1 first, which would have
  // made this test pass for the wrong reason.
  ({ path }) => writeFileSync(path("agents/orphan-reviewer.md"),
    "---\nname: orphan-reviewer\ndescription: d\nmodel: opus\ndisallowedTools: Write, Edit\n---\n\nUses `P0`, `P1` and `P2`.\n"),
  /L6: no command dispatches `orphan-reviewer`/)

// -------------------------------------------------------------------------------------------
// L7 — lenses reach the consultant only via --lenses-file, never a refuter
// -------------------------------------------------------------------------------------------

red("L7: the refuter run line passes --lenses-file",
  ({ edit }) => edit("commands/consensus-review.md", (t) =>
    t.replace('--require-key verdicts --ids-file "$WD/ids.json"', '--require-key verdicts --ids-file "$WD/ids.json" --lenses-file "$WD/lenses-consultant.md"')),
  /commands\/consensus-review\.md:\d+: L7: the refuter run line passes `--lenses-file`/)

red("L7: the consultant run line lost its --lenses-file",
  ({ edit }) => edit("commands/consensus-review.md", (t) => t.replace(' [--lenses-file "$WD/<outputs.consultant>"]', "")),
  /commands\/consensus-review\.md:\d+: L7: the consultant run line must pass lenses via/)

red("L7: the §5 consultant run line is gone",
  ({ edit }) => edit("commands/consensus-review.md", (t) => t.replace(/^node "\$H" run <name> --wd "\$WD" --name <name> --repo.*\n/m, "")),
  /commands\/consensus-review\.md:1: L7: the §5 consultant run line/)

red("L7: the §8 refuter run line is gone",
  ({ edit }) => edit("commands/consensus-review.md", (t) => t.replace(/^ *node "\$H" run <name> --wd "\$WD" --name <name>-refuter[^&]*&\n/m, "")),
  /commands\/consensus-review\.md:1: L7: the §8 refuter run line/)

// -------------------------------------------------------------------------------------------
// Unit-level behaviour of the helpers
// -------------------------------------------------------------------------------------------

test("parseFrontmatter returns null for absent and unterminated blocks", () => {
  assert.equal(parseFrontmatter("no frontmatter here"), null)
  assert.equal(parseFrontmatter("---\nname: x\nstill going"), null)
  assert.equal(parseFrontmatter("---\nname: x\n---\nbody").data.name.value, "x")
})

test("parseFrontmatter records the line a key was found on", () => {
  const fm = parseFrontmatter("---\nname: x\ndescription: d\nmodel: opus\n---\n")
  assert.equal(fm.data.model.line, 4)
})

test("vocabulary reads inside backtick spans and ignores prose", () => {
  assert.deepEqual([...vocabulary("`P0` and P1 in prose", "P[0-9]")], ["P0"])
  assert.deepEqual([...vocabulary('`"sev": "P0|P2"`', "P[0-9]")].sort(), ["P0", "P2"])
  assert.deepEqual([...vocabulary("no backticks at all", "P[0-9]")], [])
})

test("vocabulary does not match a token that merely contains the pattern", () => {
  assert.deepEqual([...vocabulary("`P00` `XP0`", "P[0-9]")], [])
})
