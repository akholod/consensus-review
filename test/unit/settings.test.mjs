// scripts/settings.mjs: the resolveSettings/parseValue core (unit) and the `resolve` command
// (CLI). Expected values come from the "Settings model" and "Test plan" sections of
// .omc/plans/args-simplification.md, not from running the code.

import { after, test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SETTINGS, main, parseProfileFile, parseValue, resolveSettings } from "../../scripts/settings.mjs"

// The user lens and profile layer comes from $XDG_CONFIG_HOME: an empty one, so ~/.config never leaks in.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "xdg-"))
after(() => rmSync(process.env.XDG_CONFIG_HOME, { recursive: true, force: true }))

const SCRIPT = new URL("../../scripts/settings.mjs", import.meta.url).pathname

const DEFAULTS = {
  depth: { value: "auto", source: "default" },
  dims: { value: "tier", source: "default" },
  lenses: { value: "auto", source: "default" },
  sceptic: { value: "strict", source: "default" },
  lang: { value: "en", source: "default" },
  out: { value: "default", source: "default" },
  archive: { value: "on", source: "default" },
  consultant: { value: "auto", source: "default" },
  extra: { value: "off", source: "default" },
  "pi-model": { value: "auto", source: "default" },
  timeout: { value: 900, source: "default" },
  models: { value: "agent", source: "default" },
  effort: { value: "agent", source: "default" },
  base: { value: null, source: "default" },
}
const DEFAULT_LINE = "Settings: depth=auto (default) | dims=tier (default) | lenses=auto (default) | sceptic=strict (default) | lang=en (default) | out=default (default) | archive=on (default) | consultant=auto (default) | extra=off (default) | pi-model=auto (default) | timeout=900 (default) | models=agent (default) | effort=agent (default)"

// ---------------------------------------------------------------------------------------------
// resolveSettings (unit)
// ---------------------------------------------------------------------------------------------

test("1: no tokens resolve every key to its default", () => {
  assert.deepEqual(resolveSettings([]), {
    schema: 1,
    target: { kind: "uncommitted", ref: null },
    settings: DEFAULTS,
    ignored: [],
    profile: null,
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
  assert.match(high.lines.settings, / \| timeout=1800 \(flag, clamped\) \| /)
  assert.deepEqual(resolveSettings(["timeout=10"]).settings.timeout, { value: 30, source: "flag" })
  const inRange = resolveSettings(["timeout=600"])
  assert.deepEqual(inRange.settings.timeout, { value: 600, source: "flag" })
  assert.match(inRange.lines.settings, / \| timeout=600 \(flag\) \| /)
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
  // One commit of the PR, not the PR: parseScope has no such shape, so neither does settings.
  "https://github.com/o/r/pull/12/commits/abc123",
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

test("base: a PR target keeps the branch name verbatim and shows it on the Settings line", () => {
  const r = resolveSettings(["#1", "base=Release/2.x"])
  assert.deepEqual(r.settings.base, { value: "Release/2.x", source: "flag" })
  assert.ok(r.lines.settings.endsWith(" | base=Release/2.x (flag)"), r.lines.settings)
})

for (const raw of ["-x", "a..b", "@{-1}", "HEAD", "a;b"]) {
  test(`base=${raw} stops: expected a branch name`, () => {
    assert.deepEqual(resolveSettings(["#1", `base=${raw}`]), { error: `base=${raw}: expected a branch name` })
  })
}

test("base without a PR target is ignored with a reason", () => {
  const r = resolveSettings(["base=release"])
  assert.deepEqual(r.settings.base, { value: null, source: "default" })
  assert.deepEqual(r.ignored, [{ token: "base=release", reason: "no PR target" }])
})

test("base is not a profile key", () => {
  assert.deepEqual(resolveSettings(["#1"], team({ base: "release" })), { error: "profile team: base is not a profile key" })
})

test("P6: a flag dims replaces the profile dims whole", () => {
  const r = resolveSettings(["dims=-quality"], team({ dims: "+tests" }))
  assert.deepEqual(r.settings.dims, { value: { add: [], remove: ["quality"] }, source: "flag" })
})

test("drift: SETTINGS keys in order", () => {
  assert.deepEqual(Object.keys(SETTINGS), [
    "depth", "dims", "lenses", "sceptic", "lang", "out", "archive", "consultant", "extra", "pi-model", "timeout", "models", "effort", "base",
  ])
})

// models / effort (steps 6-7 of .omc/plans/issue-7-profiles.md; messages from its stop-message table)

test("M1/E1: models and effort default to agent and end the Settings line", () => {
  const r = resolveSettings([])
  assert.deepEqual(r.settings.models, { value: "agent", source: "default" })
  assert.deepEqual(r.settings.effort, { value: "agent", source: "default" })
  assert.ok(r.lines.settings.endsWith(" | models=agent (default) | effort=agent (default)"), r.lines.settings)
})

test("M2: a models map is canonical in role order and marked requested", () => {
  const r = resolveSettings(["models=verifier:fable,impact:fable"])
  assert.deepEqual(r.settings.models, { value: { impact: "fable", verifier: "fable" }, source: "flag" })
  assert.ok(r.lines.settings.includes("models=impact:fable,verifier:fable (flag, requested)"), r.lines.settings)
})

test("M3: models roles and values are case-insensitive", () => {
  assert.deepEqual(resolveSettings(["models=IMPACT:Sonnet"]).settings.models.value, { impact: "sonnet" })
})

test("E2: an effort map is canonical in role order and marked requested", () => {
  const r = resolveSettings(["effort=verifier:high,impact:high,architecture:high"])
  assert.deepEqual(r.settings.effort.value, { architecture: "high", impact: "high", verifier: "high" })
  assert.ok(r.lines.settings.includes("effort=architecture:high,impact:high,verifier:high (flag, requested)"), r.lines.settings)
})

test("E3: effort roles and values are case-insensitive", () => {
  assert.deepEqual(resolveSettings(["effort=IMPACT:XHigh"]).settings.effort.value, { impact: "xhigh" })
})

const ROLE_MAP_ERRORS = [
  ["M4", "models=arch:opus", "models=arch:opus: unknown role arch (expected architecture|impact|quality|tests|verifier)"],
  ["M4", "models=impact:gpt", "models=impact:gpt: unknown model gpt (expected opus|sonnet|haiku|fable)"],
  ["M4", "models=impact:opus,impact:sonnet", "models=impact:opus,impact:sonnet: duplicate role impact"],
  ["M4", "models=impact:opus,", "models=impact:opus,: empty item"],
  ["M4", "models=impact", "models=impact: item impact is not role:model"],
  ["M4", "models=", "models=: expected agent or role:model items"],
  ["E4", "effort=arch:high", "effort=arch:high: unknown role arch (expected architecture|impact|quality|tests|verifier)"],
  ["E4", "effort=impact:huge", "effort=impact:huge: unknown effort huge (expected low|medium|high|xhigh|max)"],
  ["E4", "effort=impact:high,impact:low", "effort=impact:high,impact:low: duplicate role impact"],
  ["E4", "effort=impact:high,", "effort=impact:high,: empty item"],
  ["E4", "effort=impact", "effort=impact: item impact is not role:effort"],
  ["E4", "effort=", "effort=: expected agent or role:effort items"],
]
for (const [id, token, error] of ROLE_MAP_ERRORS) {
  test(`${id}: ${token} stops`, () => {
    assert.deepEqual(resolveSettings([token]), { error })
  })
}

test("M5: models=agent as a flag replaces the profile map", () => {
  assert.deepEqual(resolveSettings(["models=agent"], team({ models: "impact:haiku" })).settings.models, { value: "agent", source: "flag" })
})

test("M6: a flag models map replaces the profile map whole", () => {
  assert.deepEqual(resolveSettings(["models=tests:haiku"], team({ models: "impact:sonnet" })).settings.models.value, { tests: "haiku" })
})

test("M7: a profile models line keeps the value after the first colon", () => {
  assert.deepEqual(parseProfileFile("---\nmodels: verifier:fable,impact:fable\n---\n"), {
    values: { models: "verifier:fable,impact:fable" },
  })
})

test("E5: effort=agent as a flag replaces the profile map", () => {
  assert.deepEqual(resolveSettings(["effort=agent"], team({ effort: "impact:low" })).settings.effort, { value: "agent", source: "flag" })
})

test("E6: models and effort maps are independent", () => {
  const r = resolveSettings(["models=impact:sonnet", "effort=impact:max"])
  assert.deepEqual(r.settings.models.value, { impact: "sonnet" })
  assert.deepEqual(r.settings.effort.value, { impact: "max" })
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

// ---------------------------------------------------------------------------------------------
// profiles: parseProfileFile and profile= (unit). Expected values come from the "Data format",
// "Stop messages" and "Test plan" sections of .omc/plans/issue-7-profiles.md.
// ---------------------------------------------------------------------------------------------

const PROFILE_FILES = [
  ["F1", "---\ndepth: deep\nextra: pi\n---\nnotes\n", { values: { depth: "deep", extra: "pi" } }],
  ["F2", "---\n# c\n\nsceptic: basic\n---\n", { values: { sceptic: "basic" } }],
  ["F3", "depth: deep\n", { error: "no front matter" }],
  ["F4", "---\ndepth deep\n---\n", { error: "malformed line 2" }],
  ["F5", "---\nsceptic: off\nsceptic: basic\n---\n", { error: "duplicate key sceptic" }],
  ["F6", "---\ntimeout:\n---\n", { error: "empty value for timeout" }],
  ["F7", "---\n" + "# x\n".repeat(50) + "---\n", { error: "no front matter" }],
]
for (const [id, text, expected] of PROFILE_FILES) {
  test(`${id}: parseProfileFile ${JSON.stringify(text).slice(0, 40)}`, () => {
    assert.deepEqual(parseProfileFile(text), expected)
  })
}

test("R1: profile= without a layer is pending and says NOT APPLIED", () => {
  const r = resolveSettings(["profile=release"])
  assert.deepEqual(r.profile, { name: "release", pending: true })
  assert.equal(r.lines.settings, "Settings: profile release NOT APPLIED (pending)")
  assert.deepEqual(r.ignored, [])
})

test("R2: a profile name outside the lens name rule stops", () => {
  assert.deepEqual(resolveSettings(["profile=Release"]), {
    error: "profile=Release: expected a profile name ([a-z0-9][a-z0-9_-], up to 64)",
  })
})

test("R3: the last profile= wins and the earlier one is listed", () => {
  const r = resolveSettings(["profile=a", "profile=b"])
  assert.equal(r.profile.name, "b")
  assert.deepEqual(r.ignored, [{ token: "profile=a", reason: "overridden by profile=b" }])
})

test("R4: the Settings line names the profile and a flag still wins", () => {
  const { lines } = resolveSettings(["deep"], { profile: { name: "ci", values: { depth: "minimal", sceptic: "off" } } })
  assert.ok(lines.settings.includes("depth=deep (flag)"), lines.settings)
  assert.ok(lines.settings.includes("sceptic=off (profile ci)"), lines.settings)
})

test("R5: no profile= gives profile null and the default line", () => {
  const r = resolveSettings([])
  assert.equal(r.profile, null)
  assert.equal(r.lines.settings, DEFAULT_LINE)
})

// ---------------------------------------------------------------------------------------------
// settings.mjs profile (integration: a real temp repo and git)
// ---------------------------------------------------------------------------------------------

const RELEASE = "---\ndepth: deep\nextra: pi\n---\nnotes\n"
const PROFILE_FILE = ".consensus-review/profiles/release.md"
const CHANGED = `profile release: changed in this diff (${PROFILE_FILE}); commit it first or pass its settings as flags`
const NOT_TRACKED = `profile release: not tracked (${PROFILE_FILE}); commit it first or pass its settings as flags`

const git = (repo, ...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" })

/** A repo with one commit; `files` maps paths to contents (all committed unless `commit` is false). */
function profileRepo(files = { [PROFILE_FILE]: RELEASE }, { commit = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "profile-"))
  dirs.push(dir)
  const repo = join(dir, "repo")
  const wd = join(dir, "wd")
  mkdirSync(repo)
  mkdirSync(wd)
  git(repo, "init", "-q")
  git(repo, "config", "user.email", "t@example.com")
  git(repo, "config", "user.name", "t")
  writeFileSync(join(repo, "a.txt"), "a\n")
  for (const [path, text] of Object.entries(files)) put(repo, path, text)
  if (commit) {
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "init")
  }
  return { repo, wd }
}

const put = (root, path, text) => {
  mkdirSync(join(root, path, ".."), { recursive: true })
  writeFileSync(join(root, path), text)
}

/** `resolve` then `profile`, as §0 and §1.5 run them; returns the second run and settings.json before it. */
function applyProfile({ repo, wd }, { args = "profile=release", diff = "", extra = ["--repo", repo], env = process.env } = {}) {
  writeFileSync(join(wd, "args.txt"), args)
  writeFileSync(join(wd, "diff.patch"), diff)
  const first = spawnSync(process.execPath, [SCRIPT, "resolve", "--wd", wd, "--args-file", join(wd, "args.txt")], { encoding: "utf8" })
  assert.equal(first.status, 0, first.stderr)
  const before = readFileSync(join(wd, "settings.json"), "utf8")
  const run = spawnSync(process.execPath, [SCRIPT, "profile", "--wd", wd, ...extra], { encoding: "utf8", timeout: 10_000, env })
  const after = readFileSync(join(wd, "settings.json"), "utf8")
  return { ...run, before, after, saved: JSON.parse(after) }
}

/** Exit 2 with exactly `message` on stderr, and settings.json left as `resolve` wrote it. */
const assertStops = (run, message) => {
  assert.equal(run.status, 2, run.stderr)
  assert.equal(run.stderr, `${message}\n`)
  assert.equal(run.after, run.before)
}

test("L1: a committed profile applies its values with source profile", () => {
  const run = applyProfile(profileRepo())
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(run.saved.settings.depth, { value: "deep", source: "profile" })
  assert.deepEqual(run.saved.profile, { name: "release", layer: "repo", file: PROFILE_FILE })
  assert.match(run.saved.lines.settings, /^Settings: depth=deep \(profile release\) \| /)
  assert.deepEqual(JSON.parse(run.stdout), run.saved)
})

test("L2: flags beat the profile, the profile beats the default", () => {
  const run = applyProfile(profileRepo(), { args: "deep sceptic=basic profile=release" })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(run.saved.settings.sceptic, { value: "basic", source: "flag" })
  assert.deepEqual(run.saved.settings.extra, { value: "pi", source: "profile" })
  assert.deepEqual(run.saved.settings.depth, { value: "deep", source: "flag" })
})

test("L3: a profile modified in the worktree and in the uncommitted diff stops", () => {
  const ws = profileRepo()
  put(ws.repo, PROFILE_FILE, "---\nsceptic: off\n---\n")
  const diff = git(ws.repo, "diff", "HEAD")
  assertStops(applyProfile(ws, { diff, extra: ["--repo", ws.repo, "--mode", "uncommitted"] }), CHANGED)
})

test("L4: PR mode, a locally modified profile the PR diff does not touch still stops", () => {
  const ws = profileRepo()
  put(ws.repo, PROFILE_FILE, "---\nsceptic: off\n---\n")
  const diff = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n"
  assertStops(applyProfile(ws, { diff }), CHANGED)
})

test("L5: a diff that renames the profile away (oldPath) stops", () => {
  const ws = profileRepo()
  const diff = `diff --git a/${PROFILE_FILE} b/.consensus-review/profiles/old.md\nsimilarity index 100%\nrename from ${PROFILE_FILE}\nrename to .consensus-review/profiles/old.md\n`
  assertStops(applyProfile(ws, { diff }), CHANGED)
})

test("L6: an untracked profile stops", () => {
  const ws = profileRepo({})
  put(ws.repo, PROFILE_FILE, RELEASE)
  assertStops(applyProfile(ws), NOT_TRACKED)
})

test("L7: a diff adding a .gitignore rule plus an ignored untracked profile stops", () => {
  const ws = profileRepo({})
  put(ws.repo, ".gitignore", ".consensus-review/profiles/\n")
  put(ws.repo, PROFILE_FILE, RELEASE)
  const diff = "diff --git a/.gitignore b/.gitignore\nnew file mode 100644\n--- /dev/null\n+++ b/.gitignore\n@@ -0,0 +1 @@\n+.consensus-review/profiles/\n"
  assertStops(applyProfile(ws, { diff, extra: ["--repo", ws.repo, "--mode", "uncommitted"] }), NOT_TRACKED)
})

test("L8: an ignored untracked profile with no diff stops (the accepted cost)", () => {
  const ws = profileRepo({ ".gitignore": ".consensus-review/profiles/\n" })
  put(ws.repo, PROFILE_FILE, RELEASE)
  assertStops(applyProfile(ws), NOT_TRACKED)
})

test("L9: a profile that is a symlink to a committed file stops", () => {
  const ws = profileRepo({ "real.md": RELEASE, ".consensus-review/profiles/other.md": RELEASE })
  symlinkSync("../../real.md", join(ws.repo, PROFILE_FILE))
  git(ws.repo, "add", "-A")
  git(ws.repo, "commit", "-q", "-m", "link")
  assertStops(applyProfile(ws), `profile release: symlink (${PROFILE_FILE})`)
})

test("L10: a symlinked .consensus-review directory stops", () => {
  const ws = profileRepo({ "elsewhere/profiles/release.md": RELEASE })
  symlinkSync("elsewhere", join(ws.repo, ".consensus-review"))
  git(ws.repo, "add", "-A")
  git(ws.repo, "commit", "-q", "-m", "link")
  assertStops(applyProfile(ws), "profile release: symlink (.consensus-review)")
})

test("L11: a FIFO profile stops without hanging", () => {
  const ws = profileRepo({ ".consensus-review/profiles/ci.md": "---\ndepth: minimal\n---\n" })
  execFileSync("mkfifo", [join(ws.repo, PROFILE_FILE)])
  const run = applyProfile(ws)
  assert.equal(run.error, undefined, "the child must exit before its timeout")
  assertStops(run, `profile release: not a regular file (${PROFILE_FILE})`)
})

test("L12: a committed profile over 4096 bytes stops", () => {
  const ws = profileRepo({ [PROFILE_FILE]: `---\ndepth: deep\n---\n${"x".repeat(4097 - 20)}` })
  assert.equal(readFileSync(join(ws.repo, PROFILE_FILE)).length, 4097)
  assertStops(applyProfile(ws), "profile release: too large (over 4096 bytes)")
})

test("L13: only Ci.md committed: profile=ci finds nothing", () => {
  const ws = profileRepo({ ".consensus-review/profiles/Ci.md": RELEASE })
  assertStops(applyProfile(ws, { args: "profile=ci" }), "profile=ci: no such profile (available: quick, release)")
})

/** Whether `dir`'s filesystem folds case: write `x`, look for `X`. */
const foldsCase = (dir) => {
  writeFileSync(join(dir, "case-probe-x"), "")
  return existsSync(join(dir, "case-probe-X"))
}

test("L14: a diff adding a case alias of the profile", () => {
  const ws = profileRepo()
  const alias = ".consensus-review/profiles/Release.md"
  put(ws.repo, alias, "---\nsceptic: off\n---\n")
  const diff = `diff --git a/${alias} b/${alias}\nnew file mode 100644\n--- /dev/null\n+++ b/${alias}\n@@ -0,0 +1,3 @@\n+---\n+sceptic: off\n+---\n`
  const run = applyProfile(ws, { diff, extra: ["--repo", ws.repo, "--mode", "uncommitted"] })
  if (foldsCase(ws.wd)) {
    assertStops(run, CHANGED)
  } else {
    assert.equal(run.status, 0, run.stderr)
    assert.equal(run.saved.profile.file, PROFILE_FILE)
    assert.deepEqual(run.saved.settings.sceptic, { value: "strict", source: "default" })
  }
})

test("L15: an unknown name lists the valid available profiles", () => {
  const ws = profileRepo({
    ".consensus-review/profiles/ci.md": RELEASE,
    ".consensus-review/profiles/quick.md": RELEASE,
    ".consensus-review/profiles/Bad.md": RELEASE,
  })
  assertStops(applyProfile(ws, { args: "profile=nope" }), "profile=nope: no such profile (available: ci, quick, release)")
})

test("L16: no profiles directory", () => {
  assertStops(applyProfile(profileRepo({}), { args: "profile=nope" }), "profile=nope: no such profile (available: quick, release)")
})

test("L17: no --repo and no user or built-in profile of that name is the diff-only stop", () => {
  assertStops(applyProfile(profileRepo(), { args: "profile=zz", extra: [] }), "profile=zz: needs the repository (diff-only mode)")
})

test("L18: a bad value in a committed profile names the profile", () => {
  const ws = profileRepo({ [PROFILE_FILE]: "---\nsceptic: strct\n---\n" })
  assertStops(applyProfile(ws), "profile release: sceptic=strct: expected off|basic|strict")
})

test("L19: an unborn HEAD fails closed as a git error, never as changed", () => {
  const ws = profileRepo({ [PROFILE_FILE]: RELEASE }, { commit: false })
  git(ws.repo, "add", "-A")
  assertStops(applyProfile(ws), "profile release: git check failed (git ls-tree exit 128)")
})

for (const flag of ["--skip-worktree", "--assume-unchanged"]) {
  test(`L20: a profile marked ${flag} and edited on disk still stops`, () => {
    const ws = profileRepo()
    git(ws.repo, "update-index", flag, "--", PROFILE_FILE)
    put(ws.repo, PROFILE_FILE, "---\nsceptic: off\n---\n")
    assert.equal(git(ws.repo, "diff", "HEAD", "--", PROFILE_FILE), "", "the index flag hides the edit from git diff")
    assertStops(applyProfile(ws), CHANGED)
  })
}

for (const key of ["constructor", "__proto__", "toString"]) {
  test(`L21: a profile key ${key} is an unknown key`, () => {
    const ws = profileRepo({ [PROFILE_FILE]: `---\n${key}: 123\n---\n` })
    assertStops(applyProfile(ws), `profile release: unknown key ${key}`)
  })
}

test("CLI: profile with no profile= in args.txt exits 2", () => {
  const ws = profileRepo()
  writeFileSync(join(ws.wd, "args.txt"), "deep")
  writeFileSync(join(ws.wd, "diff.patch"), "")
  const run = spawnSync(process.execPath, [SCRIPT, "profile", "--wd", ws.wd, "--repo", ws.repo], { encoding: "utf8" })
  assert.equal(run.status, 2)
  assert.equal(run.stderr, "no profile=<name> in args.txt\n")
  assert.equal(existsSync(join(ws.wd, "settings.json")), false)
})

// ---------------------------------------------------------------------------------------------
// settings.mjs profile-edit, the /consensus-review:profile writer (integration: temp repo, real fs
// and git). Expected values come from step 5 and the W/P table of .omc/plans/issue-7-profiles.md.
// ---------------------------------------------------------------------------------------------

const PROFILE_DIR = ".consensus-review/profiles"
const W1_TEXT = "---\ndepth: deep\nextra: pi\ntimeout: 1200\n---\n"
const ADD_REMINDER = `Not applied until committed: git add -- ${PROFILE_FILE} && git commit -m 'Add review profile release' -- ${PROFILE_FILE}`
const DEFAULTS_LISTING = "defaults (built-in): depth=auto | dims=tier | lenses=auto | sceptic=strict | lang=en | out=default | archive=on | consultant=auto | extra=off | pi-model=auto | timeout=900 | models=agent | effort=agent"
const BUILTIN_LISTING = [
  "quick (builtin): depth=minimal dims=+quality sceptic=basic effort=impact:medium,verifier:medium",
  "release (builtin): depth=deep extra=pi timeout=1200 models=verifier:fable effort=architecture:high,impact:high,verifier:high",
]
const CI_TEXT = "---\ndepth: minimal\nsceptic: basic\ndims: impact,tests\nout: none\n---\n"

/** Runs profile-edit with `args` written to a file outside the repo; `umask` wraps it in `sh -c`. */
function edit(repo, args, { timeout = 10_000, umask = null } = {}) {
  const argsFile = join(repo, "..", "edit-args.txt")
  writeFileSync(argsFile, args)
  const argv = [SCRIPT, "profile-edit", "--repo", repo, "--args-file", argsFile]
  if (umask) return spawnSync("sh", ["-c", `umask ${umask} && exec "$0" "$@"`, process.execPath, ...argv], { encoding: "utf8", timeout })
  return spawnSync(process.execPath, argv, { encoding: "utf8", timeout })
}

const profileText = (repo) => readFileSync(join(repo, PROFILE_FILE), "utf8")

const assertEditStops = (run, message) => {
  assert.equal(run.status, 2, run.stderr)
  assert.equal(run.stderr, `${message}\n`)
}

test("W1: a new profile is written in SETTINGS order with the Add reminder and no temp left", () => {
  const { repo } = profileRepo({})
  const run = edit(repo, "release depth=deep extra=pi timeout=1200")
  assert.equal(run.status, 0, run.stderr)
  assert.equal(profileText(repo), W1_TEXT)
  assert.ok(run.stdout.includes(ADD_REMINDER), run.stdout)
  assert.deepEqual(readdirSync(join(repo, PROFILE_DIR)), ["release.md"])
})

test("W1b: an update keeps the existing file mode and says Update", () => {
  const { repo } = profileRepo({ [PROFILE_FILE]: W1_TEXT })
  chmodSync(join(repo, PROFILE_FILE), 0o600)
  const run = edit(repo, "release sceptic=basic")
  assert.equal(run.status, 0, run.stderr)
  assert.ok(run.stdout.includes(`git commit -m 'Update review profile release' -- ${PROFILE_FILE}`), run.stdout)
  assert.equal(statSync(join(repo, PROFILE_FILE)).mode & 0o777, 0o600)
})

test("W1c: a new file is 0644 under umask 022", () => {
  const { repo } = profileRepo({})
  const run = edit(repo, "release depth=deep extra=pi timeout=1200", { umask: "022" })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(statSync(join(repo, PROFILE_FILE)).mode & 0o777, 0o644)
  assert.ok(run.stdout.includes("'Add review profile release'"), run.stdout)
})

const WRITES = [
  ["W2: keys go in SETTINGS order", {}, "quick sceptic=basic dims=+quality depth=minimal", ".consensus-review/profiles/quick.md", "---\ndepth: minimal\ndims: +quality\nsceptic: basic\n---\n"],
  ["W3: the body is kept and the comment dropped", { [PROFILE_FILE]: "---\ndepth: deep\n# note\n---\nNotes.\n" }, "release sceptic=basic", PROFILE_FILE, "---\ndepth: deep\nsceptic: basic\n---\nNotes.\n"],
  ["W3b: CRLF body bytes are unchanged", { [PROFILE_FILE]: "---\r\ndepth: deep\r\n---\r\nNotes.\r\nMore.\r\n" }, "release sceptic=basic", PROFILE_FILE, "---\ndepth: deep\nsceptic: basic\n---\nNotes.\r\nMore.\r\n"],
  ["W4: key= removes the key", { [PROFILE_FILE]: W1_TEXT }, "release extra=", PROFILE_FILE, "---\ndepth: deep\ntimeout: 1200\n---\n"],
  ["W5: values are stored canonical", {}, "release sceptic=BASIC timeout=5000", PROFILE_FILE, "---\nsceptic: basic\ntimeout: 1800\n---\n"],
  ["W16: the release preset", {}, "release depth=deep extra=pi timeout=1200 models=verifier:fable effort=verifier:high,impact:high,architecture:high", PROFILE_FILE, "---\ndepth: deep\nextra: pi\ntimeout: 1200\nmodels: verifier:fable\neffort: architecture:high,impact:high,verifier:high\n---\n"],
  ["W17: the quick preset", {}, "quick depth=minimal dims=+quality sceptic=basic effort=verifier:medium,impact:medium", ".consensus-review/profiles/quick.md", "---\ndepth: minimal\ndims: +quality\nsceptic: basic\neffort: impact:medium,verifier:medium\n---\n"],
]
for (const [title, files, args, path, expected] of WRITES) {
  test(title, () => {
    const { repo } = profileRepo(files)
    const run = edit(repo, args)
    assert.equal(run.status, 0, run.stderr)
    assert.equal(readFileSync(join(repo, path), "utf8"), expected)
  })
}

test("W3: the output says the front matter comments were dropped", () => {
  const { repo } = profileRepo({ [PROFILE_FILE]: "---\ndepth: deep\n# note\n---\nNotes.\n" })
  assert.match(edit(repo, "release sceptic=basic").stdout, /comments in the front matter were dropped/)
})

const REJECTED = [
  ["W6", "release sceptic=strct", "sceptic=strct: expected off|basic|strict"],
  ["W7", "release colour=red", "unknown key colour"],
  ["W7", "release target=#1", "target is not a profile key"],
  ["W7", "release profile=x", "profile is not a profile key"],
  ["W7", "release base=main", "base is not a profile key"],
  ["W8", "Release depth=deep", "profile=Release: expected a profile name ([a-z0-9][a-z0-9_-], up to 64)"],
  ["W9", "release deep", "deep: expected key=value"],
  ["W13", "release", "profile release: nothing to write (give key=value)"],
]
for (const [id, args, message] of REJECTED) {
  test(`${id}: ${args} exits 2 and creates nothing`, () => {
    const { repo } = profileRepo({})
    assertEditStops(edit(repo, args), message)
    assert.equal(existsSync(join(repo, ".consensus-review")), false)
  })
}

test("W10: a symlinked profile is refused and its target is untouched", () => {
  const { repo } = profileRepo({ ".consensus-review/profiles/other.md": RELEASE })
  symlinkSync("other.md", join(repo, PROFILE_FILE))
  assertEditStops(edit(repo, "release depth=deep"), `profile release: symlink (${PROFILE_FILE})`)
  assert.equal(readFileSync(join(repo, PROFILE_DIR, "other.md"), "utf8"), RELEASE)
  assert.equal(readlinkSync(join(repo, PROFILE_FILE)), "other.md")
})

test("W11: a symlinked .consensus-review is refused and nothing is written under its target", () => {
  const { repo } = profileRepo({})
  mkdirSync(join(repo, "elsewhere"))
  symlinkSync("elsewhere", join(repo, ".consensus-review"))
  assertEditStops(edit(repo, "release depth=deep"), "profile release: symlink (.consensus-review)")
  assert.deepEqual(readdirSync(join(repo, "elsewhere")), [])
})

test("W12: an invalid existing file is never overwritten", () => {
  const { repo } = profileRepo({ [PROFILE_FILE]: "---\ndepth deep\n---\n" })
  assertEditStops(edit(repo, "release sceptic=basic"), "profile release: malformed line 2; fix or delete the file")
  assert.equal(profileText(repo), "---\ndepth deep\n---\n")
})

test("W14: a --repo that is not a git repository stops", () => {
  const dir = mkdtempSync(join(tmpdir(), "not-git-"))
  dirs.push(dir)
  mkdirSync(join(dir, "repo"))
  const run = edit(join(dir, "repo"), "release depth=deep")
  assert.equal(run.status, 2)
  assert.ok(run.stderr.includes("not a git repository"), run.stderr)
  assert.equal(existsSync(join(dir, "repo", ".consensus-review")), false)
})

test("W15: round trip: write, run the printed commit, then apply with profile=release", () => {
  const ws = profileRepo({})
  const run = edit(ws.repo, "release depth=deep extra=pi timeout=1200")
  assert.equal(run.status, 0, run.stderr)
  const command = run.stdout.split("Not applied until committed: ")[1].trim()
  execFileSync("sh", ["-c", command], { cwd: ws.repo, stdio: "ignore" })
  assert.equal(git(ws.repo, "status", "--porcelain"), "")
  const applied = applyProfile(ws)
  assert.equal(applied.status, 0, applied.stderr)
  assert.deepEqual(applied.saved.settings.extra, { value: "pi", source: "profile" })
})

test("W18: pre-planted temp-name symlinks are never followed or replaced", () => {
  const { repo } = profileRepo({ "victim.txt": "victim\n" })
  mkdirSync(join(repo, PROFILE_DIR), { recursive: true })
  const links = ["release.md.tmp", ".release.md.x.tmp"]
  for (const link of links) symlinkSync("../../victim.txt", join(repo, PROFILE_DIR, link))
  const run = edit(repo, "release depth=deep")
  assert.equal(run.status, 0, run.stderr)
  assert.equal(profileText(repo), "---\ndepth: deep\n---\n")
  assert.equal(readFileSync(join(repo, "victim.txt"), "utf8"), "victim\n")
  for (const link of links) assert.equal(readlinkSync(join(repo, PROFILE_DIR, link)), "../../victim.txt")
  assert.deepEqual(readdirSync(join(repo, PROFILE_DIR)).sort(), [".release.md.x.tmp", "release.md", "release.md.tmp"])
})

test("W19: printing a FIFO profile stops before the timeout", () => {
  const { repo } = profileRepo({})
  mkdirSync(join(repo, PROFILE_DIR), { recursive: true })
  execFileSync("mkfifo", [join(repo, PROFILE_FILE)])
  const run = edit(repo, "release", { timeout: 5_000 })
  assert.equal(run.error, undefined, "the child must exit before its timeout")
  assertEditStops(run, `profile release: not a regular file (${PROFILE_FILE})`)
})

test("W: <name> alone prints the existing file", () => {
  const { repo } = profileRepo({ [PROFILE_FILE]: RELEASE })
  const run = edit(repo, "release")
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout, RELEASE)
})

test("list P1: no profiles directory lists the defaults and no profiles", () => {
  const { repo } = profileRepo({})
  const run = edit(repo, "")
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout, [DEFAULTS_LISTING, "no profiles in .consensus-review/profiles/", ...BUILTIN_LISTING, ""].join("\n"))
})

test("list P0: the defaults line is built from SETTINGS", () => {
  const { repo } = profileRepo({ ".consensus-review/profiles/ci.md": CI_TEXT })
  const first = edit(repo, "").stdout.split("\n")[0]
  assert.equal(first, `defaults (built-in): ${Object.entries(SETTINGS).filter(([, s]) => s.default !== null).map(([k, s]) => `${k}=${s.default}`).join(" | ")}`)
  assert.equal(first, DEFAULTS_LISTING)
})

test("list P2: one line per profile, by layer then name, SETTINGS key order, no status", () => {
  const { repo } = profileRepo({
    ".consensus-review/profiles/ci.md": CI_TEXT,
    ".consensus-review/profiles/bad.md": "---\nsceptic: strct\n---\n",
  })
  assert.equal(edit(repo, "release depth=deep extra=pi timeout=1200").status, 0)
  const run = edit(repo, "")
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout, [
    DEFAULTS_LISTING,
    "bad (repo): invalid (sceptic=strct: expected off|basic|strict)",
    "ci (repo): depth=minimal dims=impact,tests sceptic=basic out=none",
    "release (repo): depth=deep extra=pi timeout=1200",
    BUILTIN_LISTING[0],
    BUILTIN_LISTING[1].replace("release (builtin)", "release (builtin, shadowed by repo)"),
    "",
  ].join("\n"))
})

// lenses (#12 item 1, stage 4): the dims grammar over lens names; a repository profile may only add

for (const [raw, expected] of [
  ["auto", { value: "auto" }],
  ["none", { value: "none" }],
  ["a,b", { value: { set: ["a", "b"] } }],
  ["+a,-b", { value: { add: ["a"], remove: ["b"] } }],
  ["a,+b", { error: "lenses=a,+b: mixes absolute and +/- forms" }],
  ["a,,b", { error: "lenses=a,,b: empty lens name" }],
  ["Pay", { error: "lenses=Pay: invalid lens name Pay ([a-z0-9][a-z0-9_-], up to 64)" }],
]) {
  test(`lenses: parseValue("lenses", ${JSON.stringify(raw)})`, () => {
    assert.deepEqual(parseValue("lenses", raw), expected)
  })
}

test("lenses: the Settings line shows the value and its source", () => {
  assert.match(resolveSettings(["lenses=+a,-b"]).lines.settings, / \| lenses=\+a,-b \(flag\) \| /)
  assert.match(resolveSettings([], team({ lenses: "+a" })).lines.settings, / \| lenses=\+a \(profile team\) \| /)
})

for (const raw of ["none", "-a", "a", "+a,-b"]) {
  test(`lenses: a repository profile with lenses: ${raw} stops (add-only)`, () => {
    assert.deepEqual(resolveSettings([], team({ lenses: raw })), { error: "profile team: lenses may only add (+name) in a repository profile" })
  })
}

test("lenses: profile apply, lenses: none in a committed repo profile exits 2; lenses: +a applies", () => {
  const stopped = applyProfile(profileRepo({ [PROFILE_FILE]: "---\nlenses: none\n---\n" }))
  assertStops(stopped, "profile release: lenses may only add (+name) in a repository profile")
  const applied = applyProfile(profileRepo({ [PROFILE_FILE]: "---\nlenses: +a\n---\n" }))
  assert.equal(applied.status, 0, applied.stderr)
  assert.deepEqual(applied.saved.settings.lenses, { value: { add: ["a"], remove: [] }, source: "profile" })
})

test("lenses: profile-edit writes lenses=+a and refuses lenses=none without writing", () => {
  const { repo } = profileRepo({})
  const refused = edit(repo, "p lenses=none")
  assert.equal(refused.status, 2)
  assert.equal(refused.stderr, "lenses may only add (+name) in a repository profile\n")
  assert.equal(existsSync(join(repo, ".consensus-review/profiles/p.md")), false)
  const written = edit(repo, "p lenses=+a dims=+tests")
  assert.equal(written.status, 0, written.stderr)
  assert.equal(readFileSync(join(repo, ".consensus-review/profiles/p.md"), "utf8"), "---\ndims: +tests\nlenses: +a\n---\n")
})

// ---------------------------------------------------------------------------------------------
// User and built-in profiles (#12 item 2, stage 5): user > repo > built-in; a repo or user file of
// the name that fails stops, never falls through. Built-in values are the README's.
// ---------------------------------------------------------------------------------------------

/** A fresh $XDG_CONFIG_HOME with consensus-review/profiles/<name>.md for each of `profiles`, modes set (umask-proof). */
const userEnv = (profiles = {}) => {
  const xdg = mkdtempSync(join(tmpdir(), "xdg-user-"))
  dirs.push(xdg)
  const root = join(xdg, "consensus-review")
  mkdirSync(join(root, "profiles"), { recursive: true })
  for (const dir of [root, join(root, "profiles")]) chmodSync(dir, 0o755)
  for (const [name, text] of Object.entries(profiles)) {
    writeFileSync(join(root, "profiles", `${name}.md`), text)
    chmodSync(join(root, "profiles", `${name}.md`), 0o644)
  }
  return { ...process.env, XDG_CONFIG_HOME: xdg }
}
const QUICK_FILE = ".consensus-review/profiles/quick.md"
const QUICK_VALUES = {
  depth: { value: "minimal", source: "profile" },
  dims: { value: { add: ["quality"], remove: [] }, source: "profile" },
  sceptic: { value: "basic", source: "profile" },
  effort: { value: { impact: "medium", verifier: "medium" }, source: "profile" },
}

test("layers: profile=release with no repo or user release applies the built-in README values", () => {
  const run = applyProfile(profileRepo({}))
  assert.equal(run.status, 0, run.stderr)
  const { settings } = run.saved
  assert.deepEqual([settings.depth.value, settings.extra.value, settings.timeout.value, settings.models.value],
    ["deep", "pi", 1200, { verifier: "fable" }])
  assert.deepEqual(settings.effort.value, { architecture: "high", impact: "high", verifier: "high" })
  assert.deepEqual(run.saved.profile, { name: "release", layer: "builtin", file: "builtin:profiles/release.md" })
  assert.match(run.saved.lines.settings, /^Settings: depth=deep \(profile release, builtin\) \| /)
})

test("layers: a committed repo release.md beats the built-in release", () => {
  const run = applyProfile(profileRepo({ [PROFILE_FILE]: "---\ndepth: minimal\n---\n" }))
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(run.saved.settings.depth, { value: "minimal", source: "profile" })
  assert.deepEqual(run.saved.settings.extra, { value: "off", source: "default" })
  assert.equal(run.saved.profile.layer, "repo")
})

test("layers: no repo quick.md applies the built-in quick", () => {
  const run = applyProfile(profileRepo({}), { args: "profile=quick" })
  assert.equal(run.status, 0, run.stderr)
  for (const [key, value] of Object.entries(QUICK_VALUES)) assert.deepEqual(run.saved.settings[key], value, key)
  assert.match(run.saved.lines.settings, /depth=minimal \(profile quick, builtin\)/)
})

test("layers: profile=quick with the repo quick.md changed in the diff stops; the built-in is not applied", () => {
  const ws = profileRepo({ [QUICK_FILE]: "---\nsceptic: strict\ndepth: deep\n---\n" })
  put(ws.repo, QUICK_FILE, "---\nsceptic: off\n---\n")
  const diff = git(ws.repo, "diff", "HEAD")
  assertStops(applyProfile(ws, { args: "profile=quick", diff, extra: ["--repo", ws.repo, "--mode", "uncommitted"] }),
    `profile quick: changed in this diff (${QUICK_FILE}); commit it first or pass its settings as flags`)
})

test("layers: profile=quick with a malformed committed repo quick.md stops; the built-in is not applied", () => {
  const ws = profileRepo({ [QUICK_FILE]: "depth: deep\n" })
  assertStops(applyProfile(ws, { args: "profile=quick" }), "profile quick: no front matter")
})

test("layers: a malformed user quick reserves the name over a valid repo quick", () => {
  const env = userEnv({ quick: "no front matter\n" })
  const ws = profileRepo({ [QUICK_FILE]: "---\ndepth: deep\n---\n" })
  const file = join(env.XDG_CONFIG_HOME, "consensus-review/profiles/quick.md")
  assertStops(applyProfile(ws, { args: "profile=quick", env }), `profile quick: no front matter (user ${file})`)
})

test("layers: a group-writable user profile stops with the chmod hint, never falls through", () => {
  const env = userEnv({ quick: "---\ndepth: deep\n---\n" })
  const file = join(env.XDG_CONFIG_HOME, "consensus-review/profiles/quick.md")
  chmodSync(file, 0o664)
  assertStops(applyProfile(profileRepo({}), { args: "profile=quick", env }),
    `profile quick: group-writable (${file}); fix with chmod go-w ${file} (user ${file})`)
})

test("layers: a mode-000 user root stops profile=quick with EACCES; the built-in quick is not applied", { skip: process.getuid?.() === 0 && "root ignores mode 000" }, () => {
  const env = userEnv({ quick: "---\ndepth: deep\n---\n" })
  const root = join(env.XDG_CONFIG_HOME, "consensus-review")
  chmodSync(root, 0o000)
  try {
    assertStops(applyProfile(profileRepo({}), { args: "profile=quick", env }), `profile quick: EACCES (${join(root, "profiles")}) (user)`)
  } finally {
    chmodSync(root, 0o755)
  }
})

test("layers: a user profile beats the repo one, may remove lenses, and is named (profile x, user)", () => {
  const env = userEnv({ release: "---\nlenses: none\nsceptic: off\n---\n" })
  const run = applyProfile(profileRepo(), { env })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(run.saved.settings.lenses, { value: "none", source: "profile" })
  assert.deepEqual(run.saved.settings.depth, { value: "auto", source: "default" })
  assert.equal(run.saved.profile.layer, "user")
  assert.match(run.saved.lines.settings, /sceptic=off \(profile release, user\)/)
})

test("layers: diff-only, profile=release applies the built-in; a user quick applies as (profile quick, user)", () => {
  const builtin = applyProfile(profileRepo({}), { extra: [] })
  assert.equal(builtin.status, 0, builtin.stderr)
  assert.equal(builtin.saved.profile.layer, "builtin")
  assert.match(builtin.saved.lines.settings, /depth=deep \(profile release, builtin\)/)
  const user = applyProfile(profileRepo({}), { args: "profile=quick", extra: [], env: userEnv({ quick: "---\ndepth: deep\n---\n" }) })
  assert.equal(user.status, 0, user.stderr)
  assert.match(user.saved.lines.settings, /^Settings: depth=deep \(profile quick, user\) \| /)
})

test("layers: profile=quick with the injected git failing ls-tree exits 2, settings.json unchanged", () => {
  const ws = profileRepo({ [QUICK_FILE]: "---\ndepth: deep\n---\n" })
  writeFileSync(join(ws.wd, "args.txt"), "profile=quick")
  writeFileSync(join(ws.wd, "diff.patch"), "")
  assert.equal(main(["resolve", "--wd", ws.wd, "--args-file", join(ws.wd, "args.txt")]), 0)
  const before = readFileSync(join(ws.wd, "settings.json"), "utf8")
  const failing = (cmd, args, options) => (args[0] === "ls-tree" ? { status: 128, stdout: "" } : spawnSync(cmd, args, options))
  const errors = []
  const stdoutWrite = process.stdout.write
  const stderrWrite = process.stderr.write
  process.stderr.write = (chunk) => errors.push(String(chunk))
  process.stdout.write = () => true
  let code
  try {
    code = main(["profile", "--wd", ws.wd, "--repo", ws.repo], { run: failing })
  } finally {
    process.stderr.write = stderrWrite
    process.stdout.write = stdoutWrite
  }
  assert.equal(code, 2)
  assert.equal(errors.join(""), "profile quick: git check failed (git ls-tree exit 128)\n")
  assert.equal(readFileSync(join(ws.wd, "settings.json"), "utf8"), before)
})

test("layers: the profile listing tags user profiles and the repo one they shadow", () => {
  const env = userEnv({ ci: "---\nsceptic: off\n---\n" })
  const { repo } = profileRepo({ ".consensus-review/profiles/ci.md": CI_TEXT })
  const args = join(dirs.at(-1), "args")
  writeFileSync(args, "")
  const run = spawnSync(process.execPath, [SCRIPT, "profile-edit", "--repo", repo, "--args-file", args], { encoding: "utf8", env })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout, [
    DEFAULTS_LISTING,
    "ci (user): sceptic=off",
    "ci (repo, shadowed by user): depth=minimal dims=impact,tests sceptic=basic out=none",
    ...BUILTIN_LISTING,
    "",
  ].join("\n"))
})

// ---------------------------------------------------------------------------------------------
// settings.mjs init, the /consensus-review:init-lenses writer (integration: temp repo, real fs and
// git). Expected values come from "#3 init-lenses" and the stage 6 row of
// .omc/plans/issue-12-followups.md: copies byte-equal to presets/, never overwrites, never commits.
// ---------------------------------------------------------------------------------------------

const PRESET_FILES = [
  ".consensus-review/lenses/migrations.md",
  ".consensus-review/lenses/public-api.md",
  ".consensus-review/profiles/quick.md",
  ".consensus-review/profiles/release.md",
]
const presetBytes = (file) => readFileSync(new URL(`../../presets/${file.slice(".consensus-review/".length)}`, import.meta.url))
const reminder = (files) => `Not applied until committed: git add -- ${files.join(" ")} && git commit -m 'Add review lenses and profiles' -- ${files.join(" ")}`

function init(repo, args = "") {
  const argsFile = join(repo, "..", "init-args.txt")
  writeFileSync(argsFile, args)
  return spawnSync(process.execPath, [SCRIPT, "init", "--repo", repo, "--args-file", argsFile], { encoding: "utf8", timeout: 10_000 })
}

test("I1: init in an empty repo copies every preset byte-equal, untracked, uncommitted, with the reminder", () => {
  const { repo } = profileRepo({})
  const head = git(repo, "rev-parse", "HEAD")
  const run = init(repo)
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout, `${PRESET_FILES.map((f) => `${f}: created\n`).join("")}${reminder(PRESET_FILES)}\n`)
  for (const file of PRESET_FILES) assert.deepEqual(readFileSync(join(repo, file)), presetBytes(file), file)
  assert.equal(git(repo, "rev-parse", "HEAD"), head)
  assert.equal(git(repo, "diff", "--cached", "--name-only"), "")
  assert.equal(git(repo, "status", "--porcelain", "-uall"), PRESET_FILES.map((f) => `?? ${f}\n`).join(""))
  assert.deepEqual(readdirSync(join(repo, ".consensus-review/lenses")), ["migrations.md", "public-api.md"])
})

test("I2: a re-run keeps every file (exists, kept) and prints no reminder; other bytes stay", () => {
  const { repo } = profileRepo({ ".consensus-review/lenses/migrations.md": "mine\n" })
  assert.equal(init(repo).status, 0)
  const run = init(repo)
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout, PRESET_FILES.map((f) => `${f}: exists, kept\n`).join(""))
  assert.equal(readFileSync(join(repo, PRESET_FILES[0]), "utf8"), "mine\n")
  for (const file of PRESET_FILES.slice(1)) assert.deepEqual(readFileSync(join(repo, file)), presetBytes(file), file)
})

test("I3: named presets copy only those, lens or profile", () => {
  const { repo } = profileRepo({})
  const run = init(repo, "quick migrations\n")
  assert.equal(run.status, 0, run.stderr)
  const files = [".consensus-review/lenses/migrations.md", ".consensus-review/profiles/quick.md"]
  assert.equal(run.stdout, `${files.map((f) => `${f}: created\n`).join("")}${reminder(files)}\n`)
  assert.deepEqual(readdirSync(join(repo, ".consensus-review/lenses")), ["migrations.md"])
  assert.deepEqual(readdirSync(join(repo, ".consensus-review/profiles")), ["quick.md"])
})

test("I4: an unknown name exits 2 listing the available names and writes nothing", () => {
  const { repo } = profileRepo({})
  assertEditStops(init(repo, "quick zz"), "init: no such lens or profile zz (available: migrations, public-api, quick, release)")
  assert.equal(existsSync(join(repo, ".consensus-review")), false)
})

test("I5: a symlink at a target is kept, not followed; its target is untouched", () => {
  const { repo } = profileRepo({})
  const outside = join(repo, "..", "outside.md")
  writeFileSync(outside, "outside\n")
  mkdirSync(join(repo, ".consensus-review/profiles"), { recursive: true })
  symlinkSync(outside, join(repo, ".consensus-review/profiles/quick.md"))
  const run = init(repo, "quick")
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout, ".consensus-review/profiles/quick.md: exists, kept\n")
  assert.equal(readlinkSync(join(repo, ".consensus-review/profiles/quick.md")), outside)
  assert.equal(readFileSync(outside, "utf8"), "outside\n")
})

test("I6: a FIFO or a directory at a target is kept without hanging", () => {
  const { repo } = profileRepo({})
  mkdirSync(join(repo, ".consensus-review/lenses/public-api.md"), { recursive: true })
  execFileSync("mkfifo", [join(repo, ".consensus-review/lenses/migrations.md")])
  const run = init(repo, "migrations public-api")
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout, ".consensus-review/lenses/migrations.md: exists, kept\n.consensus-review/lenses/public-api.md: exists, kept\n")
  assert.ok(statSync(join(repo, ".consensus-review/lenses/migrations.md")).isFIFO())
  assert.deepEqual(readdirSync(join(repo, ".consensus-review/lenses")).sort(), ["migrations.md", "public-api.md"])
})

test("I7: a symlinked .consensus-review exits 2 and nothing is written through it", () => {
  const { repo } = profileRepo({})
  const elsewhere = mkdtempSync(join(tmpdir(), "init-elsewhere-"))
  dirs.push(elsewhere)
  symlinkSync(elsewhere, join(repo, ".consensus-review"))
  assertEditStops(init(repo), "init: symlink (.consensus-review)")
  assert.deepEqual(readdirSync(elsewhere), [])
})

test("I8: outside a git repository init exits 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "init-nogit-"))
  dirs.push(dir)
  mkdirSync(join(dir, "repo"))
  const run = init(join(dir, "repo"))
  assert.equal(run.status, 2)
  assert.match(run.stderr, /^not a git repository/)
  assert.equal(existsSync(join(dir, "repo", ".consensus-review")), false)
})
