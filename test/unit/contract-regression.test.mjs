import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { assertStrictSchema } from "../../scripts/lib/json-schema.mjs"
import { VERDICTS } from "../../scripts/lib/lanes.mjs"
import { SETTINGS } from "../../scripts/settings.mjs"

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

test("/consensus-review's embedded schema preserves the released version", () => {
  // Guards what codex is actually sent: every released finding property is unchanged, and the
  // only addition since 1f1189b is the advisory `lens` (issue #7), required as strict mode demands.
  let released
  try {
    const md = execFileSync("git", ["show", "1f1189b:commands/consensus-review.md"], {
      cwd: new URL("../..", import.meta.url).pathname, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    })
    released = JSON.parse(md.split("```json")[1].split("```")[0])
  } catch {
    return // released revision unavailable (shallow clone); the parity check below still runs
  }
  const now = embedded().properties.findings.items
  const then = released.properties.findings.items
  for (const [key, schema] of Object.entries(then.properties)) {
    assert.deepEqual(sortDeep(now.properties[key]), sortDeep(schema), key)
  }
  assert.deepEqual(Object.keys(now.properties).filter((k) => !(k in then.properties)), ["lens"])
  assert.deepEqual(now.required.filter((k) => !then.required.includes(k)), ["lens"])
  assert.deepEqual(then.required.filter((k) => !now.required.includes(k)), [])
  const outer = (schema) => ({ ...schema, properties: { ...schema.properties, findings: { ...schema.properties.findings, items: null } } })
  assert.deepEqual(sortDeep(outer(embedded())), sortDeep(outer(released)))
})

test("the canonical finding schema requires lens as a nullable string", () => {
  const items = contract("finding.schema.json").properties.findings.items
  assert.deepEqual(items.properties.lens, { type: ["string", "null"] })
  assert.ok(items.required.includes("lens"))
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

test("the sceptic vote enum is pinned, and lanes.mjs accepts exactly it", () => {
  const verdicts = contract("verdict.schema.json").properties.verdicts.items.properties.verdict.enum
  assert.deepEqual(verdicts, ["AGREE", "DISAGREE_EVIDENCE", "DISAGREE_CONCERN"])
  assert.deepEqual(VERDICTS, verdicts, "scripts/lib/lanes.mjs must accept exactly the schema's verdicts")
})

test("the verifier and the pi refuter brief no longer ask for the legacy verdict words", () => {
  const verifier = readFileSync(new URL("../../agents/finding-verifier.md", import.meta.url), "utf8")
  // §8 still applies the decisions `confirmed|unconfirmed|refuted`; only the brief must not ask for them.
  const brief = command().split("\n").find((line) => line.includes("refuter-brief-pi.md") && line.includes("VERDICTS_START"))
  assert.ok(brief, "§8 must keep the pi refuter brief line")
  for (const text of [verifier, brief]) assert.doesNotMatch(text, /\b(?:confirmed|unconfirmed|refuted)\b/)
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
  // out=none promises zero writes; an archive call outside the file branch would break that promise.
  const md = command()
  const calls = md.split("\n").filter((l) => /archive-run\.mjs"? finish/.test(l) && !/salvage/.test(l))
  const s0 = section(md, 0)
  const s9 = section(md, 9)
  assert.ok(s0 && s9, "commands/consensus-review.md must keep sections 0 and 9")
  // the only invocation outside §9 is the salvage hint printed with the work dir in §0
  assert.equal(md.split("archive-run.mjs").length - 1, 2, "archive-run.mjs: one salvage hint in §0, one call in §9")
  assert.match(s0, /archive-run\.mjs finish --wd '<WD>'/)
  assert.equal(calls.length, 1)
  assert.ok(s9.includes(calls[0]), "the finish call lives in §9")
  assert.match(calls[0], /^cd '<literal INVOKE>' && node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/archive-run\.mjs" finish --wd '<literal WD>' --report /)
  // archive-run reads settings.json itself; the call carries only --off, and only for archive=off
  assert.doesNotMatch(calls[0], /--args-json/)
  assert.match(calls[0], /--report '<final report path>'\s+# add --off with archive=off$/)
  assert.match(s9, /on the file branch only, never with `out=none`/)
  assert.match(s9, /Before writing the report/)
  assert.match(s9, /--off with archive=off/)
  assert.match(s9, /\nArchive: </, "the header block carries the Archive line")
  assert.match(s9, /last terminal line/)
})

test("the arbiter writes the files the archive expects, with one id space", () => {
  const md = command()
  const archiveLine = section(md, 0).split("\n").find((l) => l.startsWith("- `archive`"))
  assert.ok(archiveLine, "§0 keeps the archive setting")
  assert.match(archiveLine, /`archive=off`/)
  assert.match(section(md, 0).split("\n").find((l) => l.startsWith("- `out`")) ?? "", /no run archive either/)
  assert.match(section(md, 0), /print `work dir: <WD>`/)
  assert.match(section(md, 0), /INVOKE=/)
  assert.doesNotMatch(section(md, 1), /mktemp/, "§1 no longer creates the work dir")
  assert.match(section(md, 3), /"mode": "PR\|uncommitted\|diff-only"/, "triage.json carries the mode for the archive meta")
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

test("out=none still means zero writes", () => {
  const md = command()
  assert.match(md, /none at all with `out=none`/)
  assert.match(section(md, 0), /`none` \(`no-file`\) → terminal output only: the review performs \*\*zero\*\* writes anywhere on disk/)
  assert.match(md.split("## Hard rules")[1], /with `out=none` \(`no-file`\) there is no write at all/)
  assert.match(section(md, 9), /unless `out` is `none` \(terminal only, zero writes, no archive call\)/)
})

test("§0 resolves the arguments in settings.mjs and stops on a bad value", () => {
  const s0 = section(command(), 0)
  assert.match(s0, /Write `\$ARGUMENTS` \*\*verbatim\*\*.* to `\$WD\/args\.txt`/)
  assert.match(s0, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/settings\.mjs" resolve --wd '<literal WD>' --args-file '<literal WD>\/args\.txt'/)
  assert.match(s0, /Exit 2 → print its stderr message and \*\*stop\*\*/)
  assert.match(s0, /read `\$WD\/settings\.json` and use \*\*only\*\* its values/)
  // the parsing rules live in code; their prose must not come back
  assert.doesNotMatch(s0, /\*\*`deep` wins\*\*|case-insensitive|alias/)
})

test("§9 copies the Settings and Ignored args lines verbatim and always groups P2", () => {
  const md = command()
  const s9 = md.split("\n## 9. ")[1]?.split("\n## Hard rules")[0]
  assert.match(s9, /consultant: <name> \(<reason>\)\n<lines\.settings>\n<lines\.ignored>\n/)
  assert.match(s9, /copied \*\*verbatim\*\* from `\$WD\/settings\.json`/)
  assert.doesNotMatch(s9, /extra-advisor:|timeout: <sec>|p2: </, "the header no longer repeats what Settings shows")
  assert.match(s9, /Up to 7 entries individually/)
  assert.doesNotMatch(md, /p2=/)
})

test("the command no longer mentions a retired argument", () => {
  // Plan step 2 acceptance grep; arch-reviewer and /arch-review must stay (lint L6).
  assert.doesNotMatch(command(), /no-sceptic|extra-advisor|p2=|--args-json|--extra-model|`full`|`arch`|\|arch\]|minimal arch|deep arch|`claude` ≡/)
})

test("SETTINGS, the argument-hint and the docs tables name the same keys", () => {
  assert.deepEqual(Object.keys(SETTINGS), ["depth", "dims", "sceptic", "lang", "out", "archive", "consultant", "extra", "pi-model", "timeout"])
  const hint = command().match(/^argument-hint: "(.*)"$/m)?.[1]
  assert.equal(hint, "[<PR-url|owner/repo#N|#N>] [deep|minimal] [dims=<list>] [sceptic=off|basic|strict] [lang=<language>] [no-file] [profile=<name>] [<key>=<value>…]")
  const docs = readFileSync(new URL("../../docs/consensus-review.md", import.meta.url), "utf8")
  const tables = docs.split(/^### Everyday$/m)[1].split(/^P2 findings/m)[0]
  const keys = new Set([...tables.matchAll(/^\| `([^`=]+)[=`]/gm)].map((m) => m[1]).filter((key) => key !== "Argument"))
  assert.deepEqual([...keys].sort(), [...Object.keys(SETTINGS), "<PR>", "no-file", "profile"].sort())
})

test("§1.5 applies the profile in code and stops on exit 2; §0 re-reads settings.json after it", () => {
  const md = command()
  const s15 = section(md, "1.5")
  assert.ok(s15.includes(`settings.mjs" profile --wd '<literal WD>' [--repo '<literal REPO>'] [--mode uncommitted]`), s15)
  assert.match(s15, /\*\*stop\*\*/)
  assert.match(s15, /Exit 0 → re-read `\$WD\/settings\.json`/)
  const s0 = section(md, 0)
  assert.match(s0, /re-read `settings\.json` after §1\.5/)
  assert.doesNotMatch(s0, /its values from here on/)
  assert.ok(md.indexOf("\n## 1. ") < md.indexOf("\n## 1.5. ") && md.indexOf("\n## 1.5. ") < md.indexOf("\n## 2. "), "§1.5 sits between §1 and §2")
  assert.match(md.split("\n## Hard rules")[1], /its body is ignored and never passed to a model/)
})

test("§0 states the single-quote rule and the PR commands quote every pasted value", () => {
  const md = command()
  assert.match(section(md, 0), /\*\*Quoting rule:\*\* every value .* goes in \*\*single quotes\*\*/)
  const s1 = section(md, 1)
  assert.match(s1, /`gh pr view '<target>' \[-R '<owner\/repo>'\] --json title,/)
  assert.match(s1, /`gh pr diff '<target>' \[-R '<owner\/repo>'\] > "\$WD\/diff\.patch"`/)
  assert.match(s1, /`gh pr view '<target>' \[-R '<owner\/repo>'\] --json headRefOid`/)
  assert.match(s1, /`curl -fsSL 'https:\/\/github\.com\/<owner>\/<repo>\/pull\/<N>\.diff' > "\$WD\/diff\.patch"`/)
  assert.match(section(md, 0), /written with the `'\\''` escape/)
  assert.doesNotMatch(md, /gh pr (view|diff) <target>|--report <final|--pi-model <m>|--consultant <x>|--model <model>|--wd <literal|--wd <WD>|--repo <literal|--repo "<literal|cd <literal|--head-sha <literal|--args-file <literal|--skip-reason "|WD=\/tmp/)
})

test("§0 documents the consultant cascade, the extra advisor and the family vote rules", () => {
  // Selection lives in run-lane select; the prompt must expose the flag and never re-derive it.
  const md = command()
  const s0 = section(md, 0)
  assert.match(md.split("\n---\n")[0], /\[<key>=<value>…\]/, "argument-hint points at the advanced keys")
  assert.match(s0, /`codex\|pi\|claude-cli` forces one/)
  assert.doesNotMatch(s0, /`claude` ≡ `claude-cli`/)
  assert.match(s0, /`codex` → `pi` → `claude-cli`/)
  assert.match(s0, /reported `unavailable`, never replaced/)
  assert.match(s0, /skipped \(pi is the consultant\)/)
  assert.match(s0, /pi --list-models/)
  assert.match(s0, /never falls back to pi's unpinned default/)
  assert.match(s0, /Read `extraSameEngine` from `review\.decision\.json`/)
  assert.doesNotMatch(s0, /openai-codex` \/ `gpt-5\.x/, "the prose pi-vs-codex engine check is gone")
  assert.match(s0, /with three voters .* 2 of 3 matching votes decide/)
  assert.match(s0, /a lone refuter can neither confirm nor refute/)
  assert.match(s0, /\*\*One refuter per model family\*\* \(intended change\)/)
})

test("§2 selects the consultants with one run-lane select call", () => {
  const s2 = section(command(), 2)
  assert.match(s2, /run-lane\.mjs" select --wd '<literal WD>' \[--consultant '<x>'\] \[--extra\] \[--pi-model '<m>'\]/)
  assert.equal(s2.split(" select --wd").length - 1, 1)
  assert.match(s2, /\$WD\/consultants\.json/)
  assert.doesNotMatch(s2, /codex --version|pi --version/)
})

test("§4 gives the graph CLI hint to codex only and names briefs from consultants.json", () => {
  const s4 = section(command(), 4)
  assert.match(s4, /\*\*in the codex brief only\*\*/)
  assert.match(s4, /claude-cli and pi run without a shell/)
  assert.match(s4, /each file named by a lane's `brief` in `consultants\.json`/)
  assert.match(s4, /`\$WD\/brief\.md` serves the schema lanes \(codex, claude-cli\)/)
})

test("§5 and §8 run lanes and refuters from consultants.json values, not fixed codex/pi lines", () => {
  const md = command()
  const s5 = section(md, 5)
  const s8 = section(md, 8)
  for (const s of [s5, s8]) {
    assert.doesNotMatch(s, /run (codex|pi) --wd/, "no hard-coded codex/pi lane line")
    assert.match(s, /one line per consultants\.json lane/)
  }
  assert.match(s5, /run <name> --wd "\$WD" --name <name> .*--brief-file "\$WD\/<brief>" .*\[--model '<model>'\] \[--lenses-file "\$WD\/<outputs\.consultant>"\] \[--skip <skip> --skip-reason '<skipReason>'\] &/)
  assert.match(s5, /--phase review --lanes <name>/)
  assert.match(s8, /run <name> --wd "\$WD" --name <name>-refuter .*--brief-file "\$WD\/<refuterBrief>"/)
  assert.match(s8, /--from-decision "\$WD\/review\.decision\.json"/)
  assert.match(s8, /\$WD\/<name>-refuter\.status\.json/)
  assert.match(s8, /--phase sceptic --lanes <name>-refuter/)
  assert.match(s8, /`excluded`/)
  assert.match(s8, /`strict → basic`, or `strict → basic \(no independent refuter\)`/)
  assert.match(s8, /when no refuter voted at all, `voteMode` is `strict → basic`/i)
})

test("§6/§7/§9 count families and name the consultant", () => {
  const md = command()
  const s6 = section(md, 6)
  const s7 = section(md, 7)
  const s9 = md.split("\n## 9. ")[1]?.split("\n## Hard rules")[0] // the report template has its own ## headings
  // decideReview emits `family` and `independence` at the top level, not under `lanes.<name>`.
  assert.match(s6, /top-level `family\.<name>` is the lane's model family/)
  assert.match(s6, /top-level `independence\.<name>` is `model \| context \| unknown`/)
  assert.doesNotMatch(s6, /`lanes\.<name>`[^;]*`independence`/)
  assert.match(s7, /distinct \*\*known\*\* families/)
  assert.match(s7, /every other lane's family is `family\.<name>` in `review\.decision\.json`/)
  assert.match(s7, /`\[claude\|codex\|pi\]` with codex and pi both on `openai` is \*\*two\*\* sources/)
  assert.match(s9, /`independence\.<name>` = "context" in review\.decision\.json/)
  assert.match(s9, /counted from `family\.<name>`/)
  assert.match(s6, /`extraSameEngine`/)
  assert.match(s6, /an empty `claude-cli` result is weak evidence/)
  assert.match(s7, /\*\*Agreement counts families, not tokens\.\*\*/)
  assert.match(s7, /`\[claude\|claude-cli\]` is \*\*one\*\* source/)
  assert.match(s7, /single source, i\.e\. one family/)
  assert.match(s9, /consultant: <name> \(<reason>\)/)
  assert.match(s9, /> Consultant is the same model family as the panel \(claude-cli\): context-independent only\./)
  assert.match(s9, /claude-cli=ok/)
  assert.match(s9, /`voteMode: basic \| strict \| strict → basic \| strict → basic \(no independent refuter\)`, or `fallback \(<why>\)`/)
  assert.match(s9, /F1: 2 of 2 voters — verifier: AGREE, codex: CONCERN/, "§9 shows the votes per finding, not only n of m")
  assert.match(s9, /`extraSameEngine: true`/)
})

test("§8 runs decide in both modes, states one fallback rule and the four vote rules", () => {
  const md = command()
  const s8 = section(md, 8)
  const strict = s8.indexOf("**Strict — the default.**")
  // ids.json is shared by both modes, so it is written before the basic/strict split
  assert.ok(s8.indexOf("$WD/ids.json") >= 0 && s8.indexOf("$WD/ids.json") < strict, "ids.json is written before the split")
  assert.match(s8, /\*\*Decide — both modes\.\*\*/)
  assert.ok(s8.indexOf("**Decide — both modes.**") > strict, "decide comes after the strict branch, outside it")
  assert.match(s8, /basic passes `--lanes ""`/)
  assert.match(s8, /Add `--repo` only when there is a clone, and `--head-sha` only when §1 recorded a non-empty `HEAD_SHA`; diff-only mode passes neither/)
  assert.match(s8, /read `\$WD\/sceptic\.decision\.json` \(both modes\)/)
  // exactly one fallback rule, and it never refutes
  assert.equal(s8.split("**Fallback — the one rule.**").length - 1, 1)
  assert.equal((s8.match(/fall back/gi) ?? []).length, 0, "no second fallback sentence")
  assert.match(s8, /`AGREE` \(or the legacy `confirmed`\) → `confirmed`; anything else .* → `unconfirmed`/)
  assert.match(s8, /Nothing is `refuted` without `decide`/)
  assert.match(s8, /a duplicated vote/)
  for (const rule of [/1\. no verifier vote → `unconfirmed`/, /2\. `E > A` and .*`2·E > cast`\) → `refuted`/,
    /3\. `A > E` and .*`2·A > cast`\) → `confirmed`/, /4\. anything else → `unconfirmed`/]) assert.match(s8, rule)
  assert.match(s8, /not that it is relevant/)
  assert.match(s8, /head commit missing from the local clone makes every quote outside the diff a concern/)
  assert.match(s8, /never from the raw verifier or refuter payloads/)
  assert.match(s8, /a doubt without a quote does not count against the finding/)
})

test("no text still says a tie needs both voters", () => {
  const docs = readFileSync(new URL("../../docs/consensus-review.md", import.meta.url), "utf8")
  for (const [name, text] of [["commands/consensus-review.md", command()], ["docs/consensus-review.md", docs]]) {
    assert.doesNotMatch(text, /needs? both (voters )?to survive|tie is `?unconfirmed`?, so/i, name)
    assert.doesNotMatch(text, /majority vote\*\* per finding/, name)
  }
  assert.match(docs, /a lone\s+refuter can neither confirm nor refute/)
})
