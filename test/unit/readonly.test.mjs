import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { DENIED_TOOLS, NO_MCP, buildArgs } from "../../src/loop-review/adapter.mjs"

const ROOT = new URL("../..", import.meta.url).pathname
const runtimeFiles = [
  ...readdirSync(join(ROOT, "src/loop-review")).map((f) => join("src/loop-review", f)),
  "bin/loop-review.mjs",
].filter((f) => f.endsWith(".mjs"))

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

// Two writes exist and no more: the report, and the system-prefix file the runner is handed
// instead of a 500 KB argv value. The second one is why this is a list and not a single entry —
// widened deliberately, since the promise being protected is that nothing is written INTO THE
// REVIEWED REPOSITORY, and the prefix file is confined to the run's temp cwd.
test("the runtime writes only the report and the temp system-prefix file", () => {
  const writes = []
  for (const file of runtimeFiles) {
    // call sites only — the import statement names the same symbol
    const body = source(file).replace(/^import[\s\S]*?from "[^"]+"$/gm, "")
    for (const m of body.matchAll(/\b(writeFileSync|appendFileSync|rmSync|unlinkSync|renameSync|rmdirSync)\s*\(/g)) {
      writes.push(`${file}:${m[1]}`)
    }
  }
  assert.deepEqual(writes.sort(), ["bin/loop-review.mjs:writeFileSync", "src/loop-review/adapter.mjs:writeFileSync"],
    `unexpected writes: ${writes.join(", ")}`)
  // the report write is behind --no-file
  assert.match(source("bin/loop-review.mjs"), /if \(!noFile\) \{[\s\S]*?writeFileSync/)
  // and the adapter's write is anchored to the spawn cwd, which bin/ sets to a mkdtemp directory
  assert.match(source("src/loop-review/adapter.mjs"), /systemPrefixFile = join\(cwd, SYSTEM_PREFIX_FILE\)/)
  assert.match(source("bin/loop-review.mjs"), /const workDir = mkdtempSync\(/)
})
