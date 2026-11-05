// scripts/settings.mjs: the resolveSettings/parseValue core (unit) and the `resolve` command
// (CLI). Expected values come from the "Settings model" and "Test plan" sections of
// .omc/plans/args-simplification.md, not from running the code.

import { after, test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SETTINGS, parseValue, resolveSettings } from "../../scripts/settings.mjs"

const SCRIPT = new URL("../../scripts/settings.mjs", import.meta.url).pathname

const DEFAULTS = {
  depth: { value: "auto", source: "default" },
  dims: { value: "tier", source: "default" },
  sceptic: { value: "strict", source: "default" },
  lang: { value: "en", source: "default" },
  out: { value: "default", source: "default" },
  archive: { value: "on", source: "default" },
  consultant: { value: "auto", source: "default" },
  extra: { value: "off", source: "default" },
  "pi-model": { value: "auto", source: "default" },
  timeout: { value: 900, source: "default" },
}
const DEFAULT_LINE = "Settings: depth=auto (default) | dims=tier (default) | sceptic=strict (default) | lang=en (default) | out=default (default) | archive=on (default) | consultant=auto (default) | extra=off (default) | pi-model=auto (default) | timeout=900 (default)"

// ---------------------------------------------------------------------------------------------
// resolveSettings (unit)
// ---------------------------------------------------------------------------------------------

test("1: no tokens resolve every key to its default", () => {
  assert.deepEqual(resolveSettings([]), {
    schema: 1,
    target: { kind: "uncommitted", ref: null },
    settings: DEFAULTS,
    ignored: [],
    lines: { settings: DEFAULT_LINE, ignored: "Ignored args: none" },
  })
})

test("2: a leading -- is stripped and the shorthand is case-insensitive", () => {
  assert.deepEqual(resolveSettings(["--DEEP"]).settings.depth, { value: "deep", source: "flag" })
})

test("3: depth= sets depth", () => {
  assert.equal(resolveSettings(["depth=minimal"]).settings.depth.value, "minimal")
})

test("4-5: the last depth token wins and the earlier one is listed", () => {
  const a = resolveSettings(["minimal", "deep"])
  assert.equal(a.settings.depth.value, "deep")
  assert.deepEqual(a.ignored, [{ token: "minimal", reason: "overridden by deep" }])
  const b = resolveSettings(["deep", "minimal"])
  assert.equal(b.settings.depth.value, "minimal")
  assert.deepEqual(b.ignored, [{ token: "deep", reason: "overridden by minimal" }])
})

for (const token of ["full", "arch", "no-sceptic", "extra-advisor", "extra-advisor=sonnet", "p2=full", "p2=off", "codex-only"]) {
  test(`6: removed token ${token} is ignored as unknown and changes nothing`, () => {
    const r = resolveSettings([token])
    assert.deepEqual(r.settings, DEFAULTS)
    assert.deepEqual(r.ignored, [{ token, reason: "unknown" }])
  })
}

const ERRORS = [
  ["depth=full", "depth=full: expected auto|minimal|deep"],
  ["dims=arch", "dims=arch: unknown dimension arch (expected architecture|quality|impact|tests)"],
  ["dims=impact,+tests", "dims=impact,+tests: mixes absolute and +/- forms"],
  ["dims=", "dims=: no dimensions"],
  ["sceptic=strct", "sceptic=strct: expected off|basic|strict"],
  ["lang=a;rm", "lang=a;rm: expected a language code or name (letters, digits, - or _)"],
  ["out=", "out=: expected none or a path of letters, digits and ._/~+@,-"],
  ["out=a;b", "out=a;b: expected none or a path of letters, digits and ._/~+@,-"],
  ["out=reports/(draft).md", "out=reports/(draft).md: expected none or a path of letters, digits and ._/~+@,-"],
  ["dims=impact,", "dims=impact,: empty dimension"],
  ["archive=no", "archive=no: expected on|off"],
  ["consultant=claude", "consultant=claude: expected auto|codex|pi|claude-cli"],
  ["extra=codex", "extra=codex: expected off|pi"],
  ["pi-model=$(x)", "pi-model=$(x): expected auto or a model id ([A-Za-z0-9._:/@+-], up to 100)"],
  ["timeout=abc", "timeout=abc: expected an integer"],
]
for (const [token, error] of ERRORS) {
  test(`7: ${token} stops with its literal message`, () => {
    assert.deepEqual(resolveSettings([token]), { error })
  })
}

test("8: timeout is clamped to [30, 1800] and the clamp is shown", () => {
  const high = resolveSettings(["timeout=5000"])
  assert.deepEqual(high.settings.timeout, { value: 1800, source: "flag" })
  assert.match(high.lines.settings, / \| timeout=1800 \(flag, clamped\)$/)
  assert.deepEqual(resolveSettings(["timeout=10"]).settings.timeout, { value: 30, source: "flag" })
  const inRange = resolveSettings(["timeout=600"])
  assert.deepEqual(inRange.settings.timeout, { value: 600, source: "flag" })
  assert.match(inRange.lines.settings, / \| timeout=600 \(flag\)$/)
})

test("9: a non-integer timeout stops", () => {
  assert.deepEqual(resolveSettings(["timeout=90.5"]), { error: "timeout=90.5: expected an integer" })
})

test("10: an absolute dims list sets the dimensions", () => {
  assert.deepEqual(resolveSettings(["dims=impact,quality"]).settings.dims.value, { set: ["impact", "quality"] })
})

test("11: a relative dims list adds and removes", () => {
  const r = resolveSettings(["dims=+tests,-quality"])
  assert.deepEqual(r.settings.dims.value, { add: ["tests"], remove: ["quality"] })
  assert.match(r.lines.settings, / \| dims=\+tests,-quality \(flag\) \| /)
})

test("12: no-file and out=none both turn the report file off", () => {
  assert.deepEqual(resolveSettings(["no-file"]).settings.out, { value: "none", source: "flag" })
  assert.deepEqual(resolveSettings(["out=none"]).settings.out, { value: "none", source: "flag" })
})

test("13: out keeps the path's case", () => {
  assert.equal(resolveSettings(["out=Reports/"]).settings.out.value, "Reports/")
})

test("14: archive=off is a setting, not an ignored token", () => {
  const r = resolveSettings(["archive=off"])
  assert.deepEqual(r.settings.archive, { value: "off", source: "flag" })
  assert.deepEqual(r.ignored, [])
})

test("15: #N is a PR target", () => {
  assert.deepEqual(resolveSettings(["#42"]).target, { kind: "pr", ref: "#42" })
})

test("16: a second target wins and the first is listed", () => {
  const r = resolveSettings(["o/r#7", "#9"])
  assert.equal(r.target.ref, "#9")
  assert.deepEqual(r.ignored, [{ token: "o/r#7", reason: "overridden by #9" }])
})

for (const url of ["https://github.com/o/r/pull/12/files", "https://github.com/o/r/pull/12#discussion_r1", "https://github.com/o/r/pull/12#x=1", "https://github.com/o/r/pull/12?diff=split", "https://github.com/o/r/pull/12/files?diff=split#r1"]) {
  test(`17: PR URL ${url} is a target`, () => {
    assert.deepEqual(resolveSettings([url]).target, { kind: "pr", ref: url })
  })
}

for (const token of [
  "https://github.com/o/r/pull/12/files;id",
  "https://github.com/o/r/pull/12/$(x)",
  "https://github.com/o/r/pull/12#`id`",
  "https://github.com/o/r/pull/12|id",
  "https://github.com/o/r/pull/12&id",
  "https://git;hub.com/o/r/pull/12",
  "o/r;id#12",
  "o/$(x)#12",
  "https://github.com/o/r/pull/12?a=1&b=2",
  "--https://github.com/o/r/pull/12;id",
]) {
  test(`17b: ${token} looks like a target but fails the whitelist, so the run stops`, () => {
    assert.deepEqual(resolveSettings([token]), { error: `${token}: not a valid PR target (letters, digits and ._-/#=? only)` })
  })
}

test("18: an issue URL is not a PR target and stops the run", () => {
  const url = "https://github.com/o/r/issues/12"
  assert.deepEqual(resolveSettings([url]), { error: `${url}: not a valid PR target (letters, digits and ._-/#=? only)` })
})

for (const [token, value] of [["LANG=Українська", "Українська"], ["lang=pt-BR", "pt-BR"], ["lang=es-419", "es-419"]]) {
  test(`19: ${token} keeps the language as typed`, () => {
    assert.equal(resolveSettings([token]).settings.lang.value, value)
  })
}

test("20: a quoted value split by whitespace stops on its first half", () => {
  assert.deepEqual(resolveSettings(['lang="pt', 'BR"']), {
    error: 'lang="pt: expected a language code or name (letters, digits, - or _)',
  })
})

test("21: extra=pi with a pi-model keeps the model", () => {
  const r = resolveSettings(["extra=pi", "pi-model=opencode-go/qwen3.8-max"])
  assert.equal(r.settings.extra.value, "pi")
  assert.deepEqual(r.settings["pi-model"], { value: "opencode-go/qwen3.8-max", source: "flag" })
})

test("22: pi-model with a forced non-pi consultant and no extra lane is inert", () => {
  const r = resolveSettings(["consultant=codex", "pi-model=x/y"])
  assert.deepEqual(r.settings["pi-model"], { value: "auto", source: "default" })
  assert.deepEqual(r.ignored, [{ token: "pi-model=x/y", reason: "no pi lane" }])
})

test("23: pi-model with consultant auto is kept", () => {
  const r = resolveSettings(["pi-model=x/y"])
  assert.equal(r.settings["pi-model"].value, "x/y")
  assert.deepEqual(r.ignored, [])
})

test("24: a repeated key keeps the last value", () => {
  const r = resolveSettings(["sceptic=basic", "sceptic=off"])
  assert.equal(r.settings.sceptic.value, "off")
  assert.deepEqual(r.ignored, [{ token: "sceptic=basic", reason: "overridden by sceptic=off" }])
})

test("25: the ignored line lists unknown tokens", () => {
  assert.equal(resolveSettings(["full", "sceptic=strict"]).lines.ignored, "Ignored args: full (unknown)")
})

// ---------------------------------------------------------------------------------------------
// profile seam (unit)
// ---------------------------------------------------------------------------------------------

const team = (values) => ({ profile: { name: "team", values } })

test("P1: parseValue lower-cases enum values and reports a bad one without a prefix", () => {
  assert.deepEqual(parseValue("sceptic", "BASIC"), { value: "basic" })
  assert.deepEqual(parseValue("sceptic", "strct"), { error: "sceptic=strct: expected off|basic|strict" })
})

test("P2: a profile beats the default and a flag beats the profile", () => {
  const r = resolveSettings(["deep"], team({ sceptic: "basic", depth: "minimal" }))
  assert.deepEqual(r.settings.sceptic, { value: "basic", source: "profile" })
  assert.deepEqual(r.settings.depth, { value: "deep", source: "flag" })
})

test("P3: a bad profile value names the profile", () => {
  assert.deepEqual(resolveSettings([], team({ sceptic: "strct" })), {
    error: "profile team: sceptic=strct: expected off|basic|strict",
  })
})

test("P4: an unknown profile key stops", () => {
  assert.deepEqual(resolveSettings([], team({ colour: "red" })), { error: "profile team: unknown key colour" })
})

test("P5: target and profile are not profile keys", () => {
  assert.deepEqual(resolveSettings([], team({ target: "#1" })), { error: "profile team: target is not a profile key" })
  assert.deepEqual(resolveSettings([], team({ profile: "x" })), { error: "profile team: profile is not a profile key" })
})

test("P6: a flag dims replaces the profile dims whole", () => {
  const r = resolveSettings(["dims=-quality"], team({ dims: "+tests" }))
  assert.deepEqual(r.settings.dims, { value: { add: [], remove: ["quality"] }, source: "flag" })
})

test("drift: SETTINGS keys in order", () => {
  assert.deepEqual(Object.keys(SETTINGS), ["depth", "dims", "sceptic", "lang", "out", "archive", "consultant", "extra", "pi-model", "timeout"])
})

// ---------------------------------------------------------------------------------------------
// resolve (CLI)
// ---------------------------------------------------------------------------------------------

const dirs = []
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

const resolveArgs = (text) => {
  const wd = mkdtempSync(join(tmpdir(), "settings-"))
  dirs.push(wd)
  writeFileSync(join(wd, "args.txt"), text)
  const run = spawnSync(process.execPath, [SCRIPT, "resolve", "--wd", wd, "--args-file", join(wd, "args.txt")], { encoding: "utf8" })
  return { ...run, wd, file: join(wd, "settings.json") }
}

test("CLI: resolve writes settings.json and prints the same object", () => {
  const run = resolveArgs("deep  sceptic=basic\n")
  assert.equal(run.status, 0)
  const saved = JSON.parse(readFileSync(run.file, "utf8"))
  assert.equal(saved.settings.depth.value, "deep")
  assert.equal(saved.settings.sceptic.value, "basic")
  assert.deepEqual(JSON.parse(run.stdout), saved)
})

test("CLI: an empty args file resolves to the defaults", () => {
  const run = resolveArgs("")
  assert.equal(run.status, 0)
  const saved = JSON.parse(readFileSync(run.file, "utf8"))
  assert.deepEqual(saved.settings, DEFAULTS)
  assert.equal(saved.lines.settings, DEFAULT_LINE)
})

for (const [text, message] of [["https://github.com/o/r/pull/12;id", "https://github.com/o/r/pull/12;id: not a valid PR target (letters, digits and ._-/#=? only)"], ["sceptic=strct", "sceptic=strct: expected off|basic|strict"], ["out=a;b", "out=a;b: expected none or a path of letters, digits and ._/~+@,-"]]) {
  test(`CLI: ${text} exits 2 and writes nothing`, () => {
    const run = resolveArgs(text)
    assert.equal(run.status, 2)
    assert.ok(run.stderr.includes(message), run.stderr)
    assert.equal(existsSync(run.file), false)
  })
}

test("CLI: a missing --args-file is a usage error", () => {
  const wd = mkdtempSync(join(tmpdir(), "settings-"))
  dirs.push(wd)
  const run = spawnSync(process.execPath, [SCRIPT, "resolve", "--wd", wd], { encoding: "utf8" })
  assert.equal(run.status, 2)
  assert.match(run.stderr, /^usage:/)
  assert.equal(existsSync(join(wd, "settings.json")), false)
})
