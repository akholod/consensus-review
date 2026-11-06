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
import { SETTINGS, parseProfileFile, parseValue, resolveSettings } from "../../scripts/settings.mjs"

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
function applyProfile({ repo, wd }, { args = "profile=release", diff = "", extra = ["--repo", repo] } = {}) {
  writeFileSync(join(wd, "args.txt"), args)
  writeFileSync(join(wd, "diff.patch"), diff)
  const first = spawnSync(process.execPath, [SCRIPT, "resolve", "--wd", wd, "--args-file", join(wd, "args.txt")], { encoding: "utf8" })
  assert.equal(first.status, 0, first.stderr)
  const before = readFileSync(join(wd, "settings.json"), "utf8")
  const run = spawnSync(process.execPath, [SCRIPT, "profile", "--wd", wd, ...extra], { encoding: "utf8", timeout: 10_000 })
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
  assert.deepEqual(run.saved.profile, { name: "release", file: PROFILE_FILE })
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

test("L13: only Release.md committed: profile=release finds nothing", () => {
  const ws = profileRepo({ ".consensus-review/profiles/Release.md": RELEASE })
  assertStops(applyProfile(ws), "profile=release: no such profile (available: none)")
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
  assertStops(applyProfile(ws, { args: "profile=nope" }), "profile=nope: no such profile (available: ci, quick)")
})

test("L16: no profiles directory", () => {
  assertStops(applyProfile(profileRepo({}), { args: "profile=nope" }), "profile=nope: no such profile (available: none)")
})

test("L17: no --repo is the diff-only stop", () => {
  assertStops(applyProfile(profileRepo(), { extra: [] }), "profile=release: needs the repository (diff-only mode)")
})

test("L18: a bad value in a committed profile names the profile", () => {
  const ws = profileRepo({ [PROFILE_FILE]: "---\nsceptic: strct\n---\n" })
  assertStops(applyProfile(ws), "profile release: sceptic=strct: expected off|basic|strict")
})

test("L19: an unborn HEAD fails closed as a git error, never as changed", () => {
  const ws = profileRepo({ [PROFILE_FILE]: RELEASE }, { commit: false })
  git(ws.repo, "add", "-A")
  assertStops(applyProfile(ws), "profile release: git check failed (git diff exit 128)")
})

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
const DEFAULTS_LISTING = "defaults (built-in): depth=auto | dims=tier | sceptic=strict | lang=en | out=default | archive=on | consultant=auto | extra=off | pi-model=auto | timeout=900"
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
  assert.equal(run.stdout, `${DEFAULTS_LISTING}\nno profiles in .consensus-review/profiles/\n`)
})

test("list P0: the defaults line is built from SETTINGS", () => {
  const { repo } = profileRepo({ ".consensus-review/profiles/ci.md": CI_TEXT })
  const first = edit(repo, "").stdout.split("\n")[0]
  assert.equal(first, `defaults (built-in): ${Object.entries(SETTINGS).map(([k, s]) => `${k}=${s.default}`).join(" | ")}`)
  assert.equal(first, DEFAULTS_LISTING)
})

test("list P2: one line per profile in name order, SETTINGS key order, no status", () => {
  const { repo } = profileRepo({
    ".consensus-review/profiles/ci.md": CI_TEXT,
    ".consensus-review/profiles/bad.md": "---\nsceptic: strct\n---\n",
  })
  assert.equal(edit(repo, "release depth=deep extra=pi timeout=1200").status, 0)
  const run = edit(repo, "")
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout, [
    DEFAULTS_LISTING,
    "bad: invalid (sceptic=strct: expected off|basic|strict)",
    "ci: depth=minimal dims=impact,tests sceptic=basic out=none",
    "release: depth=deep extra=pi timeout=1200",
    "",
  ].join("\n"))
})
