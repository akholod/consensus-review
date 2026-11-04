// Stand-in for `codex` / `pi` / `claude` in test/unit/run-lane.test.mjs, installed on PATH by a wrapper.
// FAKE_SCRIPT=mode,mode,… picks the behaviour of launch 1, 2, …; FAKE_DIR receives a launch
// counter, each launch's argv (and claude's session env), and the pid files the test uses to prove
// the process group died. `--version` and `pi --list-models` are not launches (the listing's argv
// goes to pi.list); FAKE_PI_LIST=fail makes the listing fail.
import { spawn } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// `node --test` loads every .mjs under test/; outside run-lane.test.mjs there is nothing to do.
if (!process.env.FAKE_DIR) process.exit(0)

const [name, ...args] = process.argv.slice(2)
const dir = process.env.FAKE_DIR
const fixture = (file) => readFileSync(new URL(`claude-cli/${file}`, import.meta.url), "utf8")
if (args[0] === "--version") {
  process.stdout.write(`${name} 0.0.0-fake\n`)
  process.exit(0)
}
if (name === "pi" && args.includes("--list-models")) {
  writeFileSync(join(dir, "pi.list"), JSON.stringify(args))
  if (process.env.FAKE_PI_LIST === "fail") process.exit(1)
  process.stdout.write(readFileSync(new URL("pi-list-models.txt", import.meta.url), "utf8"))
  process.exit(0)
}
const counter = join(dir, `${name}.count`)
const n = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1
writeFileSync(counter, String(n))
writeFileSync(join(dir, `${name}.${n}.cwd`), process.cwd())
writeFileSync(join(dir, `${name}.${n}.pid`), String(process.pid))
writeFileSync(join(dir, `${name}.${n}.argv`), JSON.stringify(args))
if (name === "claude") {
  const env = Object.fromEntries(["CLAUDECODE", "CLAUDE_CODE_SESSION_ID"].map((k) => [k, process.env[k] ?? null]))
  writeFileSync(join(dir, `${name}.${n}.env`), JSON.stringify(env))
}
const mode = (process.env.FAKE_SCRIPT ?? "ok").split(",")[n - 1] ?? "ok"

const payload = mode === "votes"
  ? { verdicts: [{ id: "F1", verdict: "refuted", evidence: "guarded at a.js:1" }] }
  : { findings: [] }
const answer = () => {
  if (name === "codex") return writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify(payload))
  if (name === "claude") {
    // stream-json: the real init event, then the real final result carrying this payload
    const lines = fixture("ok-stream.jsonl").trim().split("\n")
    const result = { ...JSON.parse(lines.at(-1)), result: JSON.stringify(payload), structured_output: payload }
    return process.stdout.write(`${lines[0]}\n${JSON.stringify(result)}\n`)
  }
  const [start, end] = mode === "votes" ? ["===VERDICTS_START===", "===VERDICTS_END==="] : ["===FINDINGS_START===", "===FINDINGS_END==="]
  const text = `${start}${JSON.stringify(Object.values(payload)[0])}${end}`
  process.stdout.write(`${JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", provider: "google", model: "gemini-test", content: [{ type: "text", text }] }] })}\n`)
}
// A grandchild that also ignores TERM, so only the group SIGKILL can end it.
const grandchild = () => {
  const gc = spawn("sh", ["-c", "trap '' TERM; exec sleep 30"], { stdio: "ignore" })
  writeFileSync(join(dir, `${name}.${n}.gc`), String(gc.pid))
}

if (mode === "ok" || mode === "votes") answer()
else if (mode === "prose") process.stdout.write(`${fixture("prose-synth.json").trim()}\n`)
else if (mode === "config") { process.stdout.write(`${fixture("error-model.json").trim()}\n`); process.exit(1) }
else if (mode === "fail") { process.stderr.write("stream disconnected\n"); process.exit(1) }
else if (mode === "schema") { process.stderr.write('{"error":{"message":"invalid_json_schema: bad"}}\n'); process.exit(1) }
else if (mode === "sleep") setTimeout(() => {}, 30_000)
else if (mode === "ignore") { process.on("SIGTERM", () => {}); grandchild(); setTimeout(() => {}, 30_000) }
else if (mode === "hang") { grandchild(); setTimeout(() => {}, 30_000) }
else if (mode === "orphan") { grandchild(); answer(); process.exit(0) }
