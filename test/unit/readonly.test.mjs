import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { DENIED_TOOLS, NO_MCP, buildArgs } from "../../src/loop-review/adapter.mjs"
import { laneCommand } from "../../scripts/lib/lanes.mjs"

const ROOT = new URL("../..", import.meta.url).pathname
const runtimeFiles = [
  ...readdirSync(join(ROOT, "src/loop-review")).map((f) => join("src/loop-review", f)),
  "bin/loop-review.mjs",
  "scripts/run-lane.mjs",
  "scripts/lib/lanes.mjs",
  "scripts/lib/archive.mjs",
  "scripts/archive-run.mjs", // created by a later story; skipped while absent
].filter((f) => f.endsWith(".mjs") && existsSync(join(ROOT, f)))

const source = (rel) => readFileSync(join(ROOT, rel), "utf8")

// The README and commands/loop-review.md both promise this. Documentation drifts from code
// silently — the F3 regression in this repo is the precedent — so the promise is asserted.

test("a review pass is denied every tool that could read or change the repository", () => {
  for (const tool of ["Edit", "Write", "NotebookEdit", "Bash", "Task", "Read", "Grep", "Glob", "WebFetch", "WebSearch"]) {
    assert.ok(DENIED_TOOLS.includes(tool), `${tool} must be denied to a review pass`)
  }
})

// `--disallowed-tools` covers built-in tools only. An MCP tool that reads source (codegraph, a
// filesystem server) is offered regardless, and is blocked only if the reviewed machine happens
// not to allowlist it — measured: an allowlisted `codegraph_explore` ran with no denial. The
// isolation promise therefore has to be enforced by removing the servers, not by naming tools.
test("a review pass is spawned with no MCP servers, whatever the machine allowlists", () => {
  const args = buildArgs({ prompt: "TAIL" })
  const i = args.indexOf("--mcp-config")
  assert.notEqual(i, -1, "an empty MCP config must be forced")
  assert.deepEqual(JSON.parse(args[i + 1]), { mcpServers: {} })
  assert.ok(args.includes("--strict-mcp-config"), "without it the empty config is merged, not substituted")
  assert.ok(args.indexOf("--mcp-config") < args.indexOf("-p"), "flags must precede the prompt")
  assert.deepEqual([...NO_MCP], ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'])
})

test("the runtime issues no mutating git or gh command", () => {
  const mutating = /"(commit|push|add|checkout|reset|apply|am|merge|rebase|stash|clean|rm|mv|tag)"/
  for (const file of runtimeFiles) {
    const text = source(file)
    const hit = text.match(mutating)
    assert.equal(hit, null, `${file} contains a mutating git verb: ${hit?.[0]}`)
  }
})

test("the only forge call reads", () => {
  const text = runtimeFiles.map(source).join("\n")
  for (const m of text.matchAll(/execFileSync\("gh", \[([^\]]*)\]/g)) {
    assert.match(m[1], /"pr", "diff"/, `unexpected gh call: gh ${m[1]}`)
  }
})

// The writes are: the report, the system-prefix file the runner is handed instead of a 500 KB argv
// value, the temp dirs they live in, and the run archive. The list is widened deliberately, since
// the promise being protected is that nothing is written INTO THE REVIEWED REPOSITORY outside the
// ignored `.reviews/`: the prefix file is confined to the run's temp cwd, the archive to its staging dir.
test("the runtime writes only the report, the temp system-prefix file and the run archive", () => {
  const writes = []
  for (const file of runtimeFiles) {
    // call sites only — the import statement names the same symbol
    const body = source(file).replace(/^import[\s\S]*?from "[^"]+"$/gm, "")
    for (const m of body.matchAll(/\b(writeFileSync|appendFileSync|rmSync|unlinkSync|renameSync|linkSync|rmdirSync|copyFileSync|cpSync|mkdirSync|mkdtempSync|chmodSync|openSync|writeSync|createWriteStream)\s*\(/g)) {
      writes.push(`${file}:${m[1]}`)
    }
  }
  assert.deepEqual(writes.sort(), [
    "bin/loop-review.mjs:mkdirSync", "bin/loop-review.mjs:mkdtempSync", "bin/loop-review.mjs:writeFileSync",
    "scripts/lib/archive.mjs:mkdirSync", "scripts/lib/archive.mjs:mkdirSync", "scripts/lib/archive.mjs:mkdtempSync",
    "scripts/lib/archive.mjs:renameSync", "scripts/lib/archive.mjs:rmSync", "scripts/lib/archive.mjs:writeFileSync",
    "scripts/run-lane.mjs:linkSync", "scripts/run-lane.mjs:openSync", "scripts/run-lane.mjs:renameSync",
    "scripts/run-lane.mjs:unlinkSync", "scripts/run-lane.mjs:writeFileSync",
    "src/loop-review/adapter.mjs:writeFileSync",
  ],
    `unexpected writes: ${writes.join(", ")}`)
  // the report write is behind --no-file
  assert.match(source("bin/loop-review.mjs"), /if \(!noFile\) \{[\s\S]*?writeFileSync/)
  // and the adapter's write is anchored to the spawn cwd, which bin/ sets to a mkdtemp directory
  assert.match(source("src/loop-review/adapter.mjs"), /systemPrefixFile = join\(cwd, SYSTEM_PREFIX_FILE\)/)
  assert.match(source("bin/loop-review.mjs"), /const workDir = mkdtempSync\(/)
})

// The archive writes only into the staging dir its own mkdtempSync returned, renames that dir into
// place, and deletes nothing else: `.reviews/` is the only directory it creates outside staging.
test("the archive lib writes under its staging dir and removes only that dir", () => {
  const body = source("scripts/lib/archive.mjs").replace(/^import[\s\S]*?from "[^"]+"$/gm, "")
  assert.match(body, /staging = mkdtempSync\(join\(dir, `\.\$\{id\}\.tmp-`\)\)/)
  const calls = (name) => [...body.matchAll(new RegExp(`\\b${name}\\((.*)$`, "gm"))].map((m) => m[1])
  assert.deepEqual(calls("rmSync"), ["staging, { recursive: true, force: true })"])
  assert.deepEqual(calls("writeFileSync"), ["join(staging, to), data, { mode: 0o600, flag: \"wx\" })"])
  assert.deepEqual(calls("mkdirSync"), [
    "dir, { recursive: true, mode: 0o700 })", "dirname(join(staging, to)), { recursive: true, mode: 0o700 })",
  ])
  assert.deepEqual(calls("renameSync"), ["staging, join(dir, name))"])
})

// The lane helper writes status, decision, canonical output and per-attempt logs — all under --wd,
// which the command creates with mktemp outside the reviewed repository.
test("the lane helper writes only under its --wd", () => {
  const text = source("scripts/run-lane.mjs")
  const calls = [...text.matchAll(/\b(writeAtomic|openSync)\((.*)$/gm)].filter((m) => !m[2].startsWith("path,"))
  assert.ok(calls.length >= 4, "expected the status, decision, output and log writes")
  for (const m of calls) assert.match(m[2], /^join\(wd, /, `${m[1]} outside --wd: ${m[0]}`)
  // writeAtomic itself is the only raw write
  assert.equal(text.match(/\b(writeFileSync|renameSync|linkSync|unlinkSync)\(/g).length, 4)
})

test("external lanes run with read-only flags and no mutating tools", () => {
  const codex = laneCommand("codex", { repo: "/r", schema: "/s", out: "/o", brief: "b" }).args
  assert.deepEqual(codex.slice(0, 6), ["exec", "-s", "read-only", "-C", "/r", "--skip-git-repo-check"])
  assert.ok(codex.includes("--output-schema") && codex.includes("-o"))
  const pi = laneCommand("pi", { repo: "/r", brief: "b" })
  assert.equal(pi.cwd, "/r")
  const tools = pi.args[pi.args.indexOf("--tools") + 1].split(",")
  assert.deepEqual(tools, ["read", "grep", "find", "ls"])
  for (const banned of ["bash", "edit", "write"]) assert.ok(!tools.includes(banned))
  // `--tools` keeps MCP tools; only `--no-mcp` keeps a server's tools away from pi
  assert.ok(pi.args.includes("--no-mcp"), "pi must run with --no-mcp")
  // pi's equivalent of claude's --safe-mode --restricted: no extension code, no saved session, no
  // skills, prompt templates, context files or project-local config
  for (const flag of ["--no-extensions", "--no-session", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve"]) {
    assert.ok(pi.args.includes(flag), `pi must run with ${flag}`)
  }
  // codex waits on an open stdin forever, so every attempt is spawned with stdin ignored
  assert.match(source("scripts/run-lane.mjs"), /stdio: \["ignore", log, log\]/)
})

// Spike issue-3: no write tool exists at all, no MCP server, no hooks/settings from the reviewed
// repo, and the file tools reach only cwd plus the work dir.
test("the claude-cli lane runs with read tools only, no MCP and no repo settings", () => {
  const cmd = laneCommand("claude-cli", { repo: "/r", wd: "/w", schema: join(ROOT, "contracts/finding.schema.json"), brief: "b" })
  const { args } = cmd
  assert.equal(cmd.bin, "claude")
  assert.equal(cmd.cwd, "/r")
  const tools = args[args.indexOf("--tools") + 1].split(",")
  assert.deepEqual(tools, ["Read", "Grep", "Glob"])
  for (const banned of ["Bash", "Edit", "Write", "NotebookEdit", "Task", "WebFetch"]) assert.ok(!tools.includes(banned), banned)
  assert.ok(!args.includes("--allowed-tools") && !args.includes("--allowedTools"), "--tools is the allowlist")
  assert.ok(args.includes("--strict-mcp-config"), "without it the empty config is merged, not substituted")
  assert.deepEqual(JSON.parse(args[args.indexOf("--mcp-config") + 1]), { mcpServers: {} })
  assert.equal(args[args.indexOf("--add-dir") + 1], "/w")
  for (const f of ["--safe-mode", "--restricted", "--no-session-persistence"]) assert.ok(args.includes(f), f)
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk")
  assert.ok(args.indexOf("--add-dir") < args.indexOf("-p") && args.at(-1) === "b", "flags must precede the prompt")
  assert.equal(cmd.env.CLAUDECODE, undefined, "the nested claude must not join the calling session")
})
