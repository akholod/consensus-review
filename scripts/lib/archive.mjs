// The run archive: a bounded, private copy of a run's artifacts in `<repo top>/.reviews/<run-id>/`.
// It is written only when git confirms the whole archive path is ignored, staged in a mkdtemp dir
// and renamed into place, so a reader never sees a half-written archive. Nothing here throws to the
// caller: every failure is `{ ok: false, reason }`, and the review goes on without an archive.

import { spawnSync } from "node:child_process"
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, normalize } from "node:path"

export const PER_FILE_CAP = 2 * 1024 * 1024
export const TOTAL_CAP = 20 * 1024 * 1024
export const SCHEMA = "consensus-review.archive/1"
const HEAD = 256 * 1024
const MAX_SUFFIX = 10

/** `<report basename without .md>-<UTC yyyymmddThhmmssZ>`. */
export function runId(reportPath, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")
  return `${basename(reportPath).replace(/\.md$/, "")}-${stamp}`
}

/**
 * True only when git prints back exactly the paths it was given: `--stdin -z` with no `-v`/`-n`
 * prints only paths that really are ignored, so a `!` negation is never read as a match.
 * Exit 1 = nothing ignored. Anything else (git missing, another exit code) fails closed.
 */
function allIgnored(top, paths, git) {
  const r = spawnSync(git, ["-C", top, "check-ignore", "--stdin", "-z"], { input: paths.map((p) => `${p}\0`).join("") })
  if (r.error || (r.status !== 0 && r.status !== 1)) return false
  const printed = new Set(r.stdout.toString().split("\0").filter(Boolean))
  return printed.size === paths.length && paths.every((p) => printed.has(p))
}

/** Where the archive may go: `{ ok, dir, top }`, or `{ ok: false, reason }` before anything is written. */
export function canArchive(repo, id, { git = "git" } = {}) {
  try {
    const r = spawnSync(git, ["-C", repo, "rev-parse", "--show-toplevel"])
    if (r.error || r.status !== 0) return { ok: false, reason: "not in a git worktree" }
    const top = r.stdout.toString().trim()
    const dir = join(top, ".reviews")
    let st = null
    try {
      st = lstatSync(dir)
    } catch (err) {
      if (err.code !== "ENOENT") throw err
    }
    if (st?.isSymbolicLink()) return { ok: false, reason: ".reviews is a symlink" }
    if (st && !st.isDirectory()) return { ok: false, reason: ".reviews is not a directory" }
    const dirs = [".reviews/", `.reviews/${id}/`, `.reviews/.${id}.tmp-probe/`]
    if (!allIgnored(top, dirs, git)) return { ok: false, reason: ".reviews/ is not gitignored as a directory" }
    return { ok: true, dir, top }
  } catch (err) {
    return { ok: false, reason: err.message }
  }
}

/** Over the per-file cap: the head 256 KiB and the tail, around a marker. Errors sit at the end. */
export function truncate(buf) {
  if (buf.length <= PER_FILE_CAP) return buf
  // The omitted count includes the marker's own bytes, so size the marker once, then recount.
  const mark = (n) => Buffer.from(`\n…[truncated ${n} bytes]…\n`)
  let marker = mark(buf.length - PER_FILE_CAP)
  for (let prev = -1; prev !== marker.length;) prev = marker.length, marker = mark(buf.length - PER_FILE_CAP + marker.length)
  const tail = PER_FILE_CAP - HEAD - marker.length
  return Buffer.concat([buf.subarray(0, HEAD), marker, buf.subarray(buf.length - tail)])
}

/**
 * Stage `diff.patch` (never cut), then `entries` in cap-priority order (`{to, from}` or
 * `{to, content}`), then `meta.json`, and rename the staging dir into `<dir>/<runId>[-n]`.
 * `hooks.onWrite(rel)` and `hooks.beforeRename(staging)` exist for tests.
 */
export function writeArchive({ dir, runId: id, entries = [], meta = {}, diff, repoTop, git = "git", hooks = {} }) {
  const diffBuf = diff == null ? null : Buffer.from(diff)
  if (diffBuf && diffBuf.length > TOTAL_CAP) return { ok: false, reason: "diff larger than 20 MiB" }
  let staging = null
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    staging = mkdtempSync(join(dir, `.${id}.tmp-`))
    const written = []
    const put = (to, data) => {
      if (isAbsolute(to) || normalize(to).startsWith("..")) throw new Error(`entry path escapes the archive: ${to}`)
      mkdirSync(dirname(join(staging, to)), { recursive: true, mode: 0o700 })
      writeFileSync(join(staging, to), data, { mode: 0o600, flag: "wx" })
      written.push(to)
      hooks.onWrite?.(to)
    }
    const truncated = []
    let total = 0
    if (diffBuf) put("diff.patch", diffBuf), total += diffBuf.length
    for (const e of entries) {
      const raw = "from" in e ? readFileSync(e.from) : Buffer.from(e.content)
      const data = truncate(raw)
      if (total + data.length > TOTAL_CAP) {
        truncated.push({ path: e.to, bytes: raw.length, action: "dropped" })
        continue
      }
      if (data !== raw) truncated.push({ path: e.to, bytes: raw.length, action: "truncated" })
      put(e.to, data)
      total += data.length
    }
    // Pick the final name before meta.json is written, so meta.runId names the real directory.
    // rename(2) silently replaces an existing empty directory, so skip names that already exist.
    // Residual race: a dir created by another process before the rename below can still be replaced if empty.
    let name = null
    for (let n = 1; n <= MAX_SUFFIX && !name; n++) {
      const cand = n === 1 ? id : `${id}-${n}`
      if (!lstatSync(join(dir, cand), { throwIfNoEntry: false })) name = cand
    }
    if (!name) throw new Error(`.reviews/${id} exists ${MAX_SUFFIX} times over`)
    const full = { schema: SCHEMA, runId: name, ...meta, truncated: [...(meta.truncated ?? []), ...truncated] }
    put("meta.json", `${JSON.stringify(full, null, 2)}\n`)
    hooks.beforeRename?.(staging)
    if (!allIgnored(repoTop, written.map((to) => `.reviews/${name}/${to}`), git)) throw new Error(`.reviews/${name}/ is not gitignored`)
    renameSync(staging, join(dir, name))
    return { ok: true, dir: join(dir, name) }
  } catch (err) {
    if (staging) rmSync(staging, { recursive: true, force: true })
    return { ok: false, reason: err.message }
  }
}

const plus = (iso, seconds) => (iso && Number.isFinite(seconds) ? new Date(Date.parse(iso) + seconds * 1000).toISOString() : null)

/**
 * `events.jsonl` from what the run already wrote: lane statuses (`{name: status.json}`), the
 * decisions (`{name: decision.json}`) and triage. Sorted by `ts`; events without one go last.
 */
export function deriveEvents({ statuses = {}, decisions = {}, triage } = {}) {
  const events = []
  if (triage) events.push({ ts: triage.ts ?? null, type: "triage", source: "arbiter", ...triage })
  for (const [source, s] of Object.entries(statuses)) {
    const attempts = s.attempts ?? []
    attempts.forEach((a, i) => {
      const ts = a.startedAt ?? null
      if (i > 0) events.push({ ts, type: "retry", source, n: a.n, after: attempts[i - 1].status })
      events.push({ ts, type: "attempt.start", source, n: a.n })
      events.push({ ts: plus(ts, a.seconds), type: "attempt.finish", source, n: a.n, status: a.status, reason: a.reason, rc: a.rc })
    })
    if (["degraded", "failed", "skipped"].includes(s.status)) {
      const last = attempts.at(-1)
      events.push({ ts: last ? plus(last.startedAt, last.seconds) : null, type: "lane.final", source, status: s.status, display: s.display })
    }
  }
  for (const [source, { lanes, ...d }] of Object.entries(decisions)) events.push({ ts: d.ts ?? null, type: "decide", source, ...d })
  const key = (e) => (e.ts === null ? Infinity : Date.parse(e.ts))
  return events.sort((a, b) => key(a) - key(b))
}
