// Unit tests for scripts/lib/archive.mjs, against real git in temp repos under os.tmpdir().

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PER_FILE_CAP, SCHEMA, TOTAL_CAP, canArchive, deriveEvents, runId, truncate, writeArchive } from "../../scripts/lib/archive.mjs"

const ID = "review-20260102T030405Z"
const MiB = 1024 * 1024

function repo(gitignore) {
  const base = mkdtempSync(join(tmpdir(), "archive-"))
  const top = join(base, "repo")
  mkdirSync(top)
  execFileSync("git", ["init", "-q", top])
  if (gitignore != null) writeFileSync(join(top, ".gitignore"), gitignore)
  return { base, top, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

const archive = (top, args = {}) =>
  writeArchive({ dir: join(top, ".reviews"), runId: ID, repoTop: top, diff: "diff --git a b\n", entries: [], meta: {}, ...args })

const reviews = (top) => (existsSync(join(top, ".reviews")) ? readdirSync(join(top, ".reviews")) : [])

test("runId is the report basename and a UTC stamp", () => {
  assert.equal(runId("/x/.reviews/pr-12.md", new Date("2026-01-02T03:04:05.678Z")), "pr-12-20260102T030405Z")
  assert.equal(runId("notes", new Date("2026-11-04T00:00:00Z")), "notes-20261104T000000Z")
})

test("canArchive: .reviews/ ignored and the dir missing -> ok, nothing created", (t) => {
  const r = repo(".reviews/\n")
  t.after(r.cleanup)
  const res = canArchive(r.top, ID)
  assert.deepEqual(res, { ok: true, dir: join(r.top, ".reviews"), top: r.top })
  assert.equal(existsSync(join(r.top, ".reviews")), false)
})

test("canArchive: rules that do not ignore the whole directory are rejected", (t) => {
  for (const rules of ["", ".reviews/*.md\n", ".reviews/**/meta.json\n", "!.reviews/\n", ".reviews/\n!.reviews/\n",
    `.reviews/*\n!.reviews/${ID}/\n`]) {
    const r = repo(rules)
    t.after(r.cleanup)
    assert.deepEqual(canArchive(r.top, ID), { ok: false, reason: ".reviews/ is not gitignored as a directory" }, rules)
    assert.deepEqual(reviews(r.top), [], rules)
  }
})

test("canArchive: outside a worktree", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "archive-norepo-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.deepEqual(canArchive(dir, ID), { ok: false, reason: "not in a git worktree" })
})

test("canArchive: git exiting 128 inside a repo (safe.directory) fails closed", (t) => {
  const r = repo(".reviews/\n")
  t.after(r.cleanup)
  const fake = join(r.base, "git")
  writeFileSync(fake, "#!/bin/sh\necho 'fatal: detected dubious ownership' >&2\nexit 128\n")
  chmodSync(fake, 0o755)
  assert.deepEqual(canArchive(r.top, ID, { git: fake }), { ok: false, reason: "not in a git worktree" })
})

test("canArchive: git missing from PATH fails closed", (t) => {
  const r = repo(".reviews/\n")
  t.after(r.cleanup)
  const path = process.env.PATH
  process.env.PATH = join(r.base, "empty")
  try {
    assert.equal(canArchive(r.top, ID).ok, false)
  } finally {
    process.env.PATH = path
  }
})

test("canArchive: a repo reached through a symlinked path is fine", (t) => {
  const r = repo(".reviews/\n")
  t.after(r.cleanup)
  symlinkSync(r.top, join(r.base, "link"))
  const res = canArchive(join(r.base, "link"), ID)
  assert.equal(res.ok, true)
  assert.equal(res.top, r.top)
})

test("canArchive: .reviews itself a symlink is rejected", (t) => {
  const r = repo(".reviews\n")
  t.after(r.cleanup)
  mkdirSync(join(r.base, "elsewhere"))
  symlinkSync(join(r.base, "elsewhere"), join(r.top, ".reviews"))
  assert.deepEqual(canArchive(r.top, ID), { ok: false, reason: ".reviews is a symlink" })
})

test("canArchive and writeArchive handle -z output for a run-id with spaces", (t) => {
  const r = repo(".reviews/\n")
  t.after(r.cleanup)
  const id = "my report-20260102T030405Z"
  assert.equal(canArchive(r.top, id).ok, true)
  const res = archive(r.top, { runId: id })
  assert.equal(res.ok, true)
  assert.equal(res.dir, join(r.top, ".reviews", id))
})

test("a negation of a file under an ignored dir cannot re-include it, so the archive is written", (t) => {
  const r = repo(".reviews/\n!meta.json\n!*.patch\n")
  t.after(r.cleanup)
  assert.equal(canArchive(r.top, ID).ok, true)
  assert.equal(archive(r.top).ok, true)
})

test("truncate: the marker counts the omitted bytes exactly, at the cap boundary too", () => {
  for (const extra of [1, 9, 10, 99, 100, 12345]) {
    const out = truncate(Buffer.alloc(PER_FILE_CAP + extra, "x"))
    const m = out.toString().match(/\n…\[truncated (\d+) bytes\]…\n/)
    assert.equal(out.length, PER_FILE_CAP, `extra ${extra}`)
    assert.equal(Number(m[1]), PER_FILE_CAP + extra - (out.length - Buffer.byteLength(m[0])), `extra ${extra}`)
  }
})

test("truncate keeps the head 256 KiB and the tail around a marker", () => {
  const small = Buffer.from("abc")
  assert.equal(truncate(small), small)
  const big = Buffer.alloc(3 * MiB, "m")
  big.fill("H", 0, 256 * 1024)
  big.fill("T", big.length - 1000)
  const out = truncate(big)
  assert.equal(out.length, PER_FILE_CAP)
  assert.equal(out.subarray(0, 256 * 1024).toString(), "H".repeat(256 * 1024))
  assert.equal(out.subarray(256 * 1024, 256 * 1024 + 1).toString(), "\n")
  const m = out.toString().match(/\n…\[truncated (\d+) bytes\]…\n/)
  assert.ok(m, "marker present")
  const tail = out.length - 256 * 1024 - Buffer.byteLength(m[0])
  assert.equal(Number(m[1]), big.length - 256 * 1024 - tail, "the marker counts exactly the omitted bytes")
  assert.ok(out.subarray(-1000).equals(Buffer.alloc(1000, "T")))
})

test("writeArchive: entries in priority order, a big log truncated, overflow dropped and listed", (t) => {
  const r = repo(".reviews/\n")
  t.after(r.cleanup)
  const diff = Buffer.alloc(3 * MiB, "d")
  const entries = [
    { to: "events.jsonl", content: "{}\n" },
    { to: "sources/codex/attempt-1.log", content: Buffer.alloc(3 * MiB, "l") },
    ...Array.from({ length: 8 }, (_, i) => ({ to: `sources/s${i}/output.txt`, content: Buffer.alloc(2 * MiB, "o") })),
    { to: "sources/late/output.txt", content: Buffer.alloc(MiB / 2, "x") },
  ]
  const res = archive(r.top, { diff, entries })
  assert.equal(res.ok, true)
  assert.ok(readFileSync(join(res.dir, "diff.patch")).equals(diff), "the diff is never truncated")
  assert.equal(statSync(join(res.dir, "sources/codex/attempt-1.log")).size, PER_FILE_CAP)
  // 3 (diff) + 2 (log) + 7 * 2 = 19 MiB; s7 (2 MiB) does not fit, the 512 KiB late entry does
  assert.equal(existsSync(join(res.dir, "sources/s6/output.txt")), true)
  assert.equal(existsSync(join(res.dir, "sources/s7/output.txt")), false)
  assert.equal(existsSync(join(res.dir, "sources/late/output.txt")), true)
  const meta = JSON.parse(readFileSync(join(res.dir, "meta.json"), "utf8"))
  assert.equal(meta.schema, SCHEMA)
  assert.equal(meta.runId, ID)
  assert.deepEqual(meta.truncated, [
    { path: "sources/codex/attempt-1.log", bytes: 3 * MiB, action: "truncated" },
    { path: "sources/s7/output.txt", bytes: 2 * MiB, action: "dropped" },
  ])
})

test("writeArchive: a diff over the total cap skips the archive, nothing written", (t) => {
  const r = repo(".reviews/\n")
  t.after(r.cleanup)
  assert.deepEqual(archive(r.top, { diff: Buffer.alloc(TOTAL_CAP + 1) }), { ok: false, reason: "diff larger than 20 MiB" })
  assert.equal(existsSync(join(r.top, ".reviews")), false)
})

test("writeArchive: meta.json is the last file written; modes are 0700/0600", (t) => {
  const r = repo(".reviews/\n")
  t.after(r.cleanup)
  const order = []
  const res = archive(r.top, {
    entries: [{ to: "events.jsonl", content: "" }, { to: "sources/codex/status.json", content: "{}" }],
    hooks: { onWrite: (to) => order.push(to) },
  })
  assert.equal(res.ok, true)
  assert.deepEqual(order, ["diff.patch", "events.jsonl", "sources/codex/status.json", "meta.json"])
  const mode = (p) => statSync(p).mode & 0o777
  assert.equal(mode(res.dir), 0o700)
  assert.equal(mode(join(res.dir, "sources")), 0o700)
  assert.equal(mode(join(res.dir, "sources/codex")), 0o700)
  for (const f of order) assert.equal(mode(join(res.dir, f)), 0o600, f)
})

test("writeArchive: a copy error leaves neither the final nor the staging dir", (t) => {
  const r = repo(".reviews/\n")
  t.after(r.cleanup)
  const res = archive(r.top, { entries: [{ to: "a.log", from: join(r.base, "missing.log") }] })
  assert.equal(res.ok, false)
  assert.match(res.reason, /ENOENT/)
  assert.deepEqual(reviews(r.top), [])
})

test("writeArchive: an entry path that escapes the archive is an error", (t) => {
  const r = repo(".reviews/\n")
  t.after(r.cleanup)
  assert.equal(archive(r.top, { entries: [{ to: "../x", content: "" }] }).ok, false)
  assert.deepEqual(reviews(r.top), [])
  assert.equal(existsSync(join(r.top, "x")), false)
})

test("writeArchive: a failed final ignore check removes the staging dir", (t) => {
  const r = repo(".reviews/\n")
  t.after(r.cleanup)
  const res = archive(r.top, {
    hooks: { beforeRename: () => writeFileSync(join(r.top, ".gitignore"), `.reviews/*\n!.reviews/${ID}/\n`) },
  })
  assert.deepEqual(res, { ok: false, reason: `.reviews/${ID}/ is not gitignored` })
  assert.deepEqual(reviews(r.top), [])
})

test("writeArchive: a rename collision retries with -2", (t) => {
  const r = repo(".reviews/\n")
  t.after(r.cleanup)
  mkdirSync(join(r.top, ".reviews", ID), { recursive: true })
  writeFileSync(join(r.top, ".reviews", ID, "old"), "kept")
  const res = archive(r.top)
  assert.deepEqual(res, { ok: true, dir: join(r.top, ".reviews", `${ID}-2`) })
  assert.equal(readFileSync(join(r.top, ".reviews", ID, "old"), "utf8"), "kept")
  assert.equal(JSON.parse(readFileSync(join(res.dir, "meta.json"), "utf8")).runId, `${ID}-2`)
  assert.deepEqual(reviews(r.top).sort(), [ID, `${ID}-2`])
})

test("writeArchive: an existing empty dir is not replaced; the run goes to -2", (t) => {
  const r = repo(".reviews/\n")
  t.after(r.cleanup)
  mkdirSync(join(r.top, ".reviews", ID), { recursive: true })
  const res = archive(r.top)
  assert.deepEqual(res, { ok: true, dir: join(r.top, ".reviews", `${ID}-2`) })
  assert.deepEqual(readdirSync(join(r.top, ".reviews", ID)), [])
  assert.deepEqual(reviews(r.top).sort(), [ID, `${ID}-2`])
})

const T0 = "2026-01-02T03:00:00.000Z"
const at = (s) => new Date(Date.parse(T0) + s * 1000).toISOString()
const types = (events) => events.map((e) => `${e.type}:${e.source}${e.status ? `:${e.status}` : ""}`)

test("deriveEvents: ok, fail+ok, fail+fail, config failure, skipped, triage, decide", () => {
  const a = (n, status, start, seconds) => ({ n, status, reason: status === "ok" ? null : status, rc: 0, seconds, startedAt: at(start) })
  const events = deriveEvents({
    triage: { ts: T0, tier: "standard", dims: ["impact"], basis: "small diff" },
    statuses: {
      codex: { status: "ok", display: "ok (retried: unparseable)", attempts: [a(1, "unparseable", 1, 10), a(2, "ok", 12, 5)] },
      pi: { status: "ok", display: "ok", attempts: [a(1, "ok", 2, 3)] },
      "codex-refuter": { status: "degraded", display: "degraded", attempts: [a(1, "failed", 30, 1), a(2, "timeout", 32, 4)] },
      "pi-refuter": { status: "failed", display: "failed: 401", attempts: [a(1, "config", 31, 2)] },
      other: { status: "skipped", display: "skipped (off)", attempts: [] },
    },
    decisions: { review: { lanes: {}, ts: at(20), allExternalDown: false }, sceptic: { lanes: {}, voteMode: "strict" } },
  })
  assert.deepEqual(types(events), [
    "triage:arbiter",
    "attempt.start:codex", "attempt.start:pi", "attempt.finish:pi:ok", "attempt.finish:codex:unparseable",
    "retry:codex", "attempt.start:codex", "attempt.finish:codex:ok", "decide:review",
    "attempt.start:codex-refuter", "attempt.finish:codex-refuter:failed", "attempt.start:pi-refuter",
    "retry:codex-refuter", "attempt.start:codex-refuter", "attempt.finish:pi-refuter:config", "lane.final:pi-refuter:failed",
    "attempt.finish:codex-refuter:timeout", "lane.final:codex-refuter:degraded",
    "lane.final:other:skipped", "decide:sceptic",
  ])
  assert.equal(events.find((e) => e.type === "retry" && e.source === "codex").after, "unparseable")
  assert.equal(events.find((e) => e.type === "decide").lanes, undefined)
  assert.equal(events.at(-1).ts, null)
})
