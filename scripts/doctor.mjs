#!/usr/bin/env node
// Summary diagnostic for consensus-review.
//
// Why this exists: the review degrades SILENTLY by design. An unavailable consultant marks its lane
// `unavailable` and the run continues; if every consultant fails, the floor case builds the report
// from the Claude lane alone and does not abort. Each of those is the right call at run time — a
// partial review beats none — but together they mean a misconfigured setup produces a report that
// looks complete and is quietly weaker. This turns that into a statement you read BEFORE you rely
// on a review, instead of a status line you notice afterwards.
//
// It checks FUNCTION, not presence. `codex --version` passes with stale auth and with a schema
// codex would reject — the exact failure commands/consensus-review.md calls "a config bug to fix,
// not a clean review". A doctor that reported "ok" on that would be making the dispatch-is-not-
// coverage mistake this plugin exists to catch.
//
//   node scripts/doctor.mjs                 full check, including live calls
//   node scripts/doctor.mjs --offline       skip everything that costs a call
//   node scripts/doctor.mjs --repo <path>   diagnose another repository
//   node scripts/doctor.mjs --json          machine-readable
//   node scripts/doctor.mjs --consultant <x> check the consultant a review forced with consultant=<x>
import { execFileSync } from "node:child_process"
import { existsSync, statSync, readFileSync, accessSync, constants } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { lint } from "./lint-prompts.mjs"
import { listPiModels, probeClaude, probeClaudeCli, probeCodex, toolVersion } from "./lib/probe.mjs"
import { selectConsultants } from "./lib/lanes.mjs"
import { instructionMatches, sourceRoots } from "../src/loop-review/context.mjs"
import { loadSources } from "./lenses.mjs"
import { SETTINGS, listProfiles } from "./settings.mjs"

const SELF = join(dirname(fileURLToPath(import.meta.url)), "..")

const sh = (cmd, args, opts = {}) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], ...opts }).trim()
  } catch {
    return null
  }
}

/**
 * Run every check and return the results. Exported so the tests can drive it in-process against
 * deliberately broken workspaces — the same shape `lint-prompts.mjs` uses.
 */
export function diagnose({ root = SELF, repo = process.cwd(), offline = false, consultant: forced = null, sources = {} } = {}) {
  const ROOT = root
  const REPO = repo
  const OFFLINE = offline
  const results = []
  /** `consequence` is the point of this tool: what a non-ok state silently does to a review. */
  const add = (section, label, status, detail = "", consequence = "") =>
    results.push({ section, label, status, detail, consequence })

  // ── Plugin ───────────────────────────────────────────────────────────────────────────────────
  {
    const manifest = JSON.parse(readFileSync(join(ROOT, ".claude-plugin/plugin.json"), "utf8"))
    const installed = manifest.version
    // Version skew is not hypothetical: this repository was running 0.7.0 while 0.8.2 was released,
    // and nothing surfaced it. The lookup reaches GitHub, so it is gated with the model probes —
    // `--offline` has to mean no network at all, or the flag is lying about what it does.
    const latest = OFFLINE
      ? null
      : sh("gh", ["release", "list", "--limit", "1", "--json", "tagName", "-q", ".[0].tagName"], { cwd: ROOT })
    const latestVersion = latest?.match(/v(\d+\.\d+\.\d+)/)?.[1]
    if (OFFLINE) {
      add("plugin", "version", "skip", `installed ${installed}; --offline`,
        "cannot tell whether this copy is behind the latest release")
    } else if (!latestVersion) {
      add("plugin", "version", "warn", `installed ${installed}; could not reach the release list`,
        "cannot tell whether this copy is current")
    } else if (latestVersion === installed) {
      add("plugin", "version", "ok", `${installed} (latest)`)
    } else {
      add("plugin", "version", "warn", `installed ${installed}, latest ${latestVersion}`,
        "you are reviewing with older prompts and contracts than the released ones")
    }

    const major = Number(process.versions.node.split(".")[0])
    add("plugin", "node", major >= 20 ? "ok" : "fail", process.version,
      major >= 20 ? "" : "the loop-review runtime requires Node >= 20")
  }

  // ── Consultants ──────────────────────────────────────────────────────────────────────────────
  //
  // Severity rule, applied throughout: `fail` means a review cannot run, or runs on something
  // broken you believe is working. Merely running with fewer sources is `warn` — the floor case
  // builds the report from the Claude lane alone and explicitly does not abort, so a consultant you
  // never installed is a choice, not a fault. A consultant that IS installed and does not work is a
  // fail, because that is the config bug you cannot see from the outside.
  {
    const codex = toolVersion("codex")
    add("consultants", "codex", codex ? "ok" : "warn", codex ?? "not installed",
      codex ? "" : "the review falls back to pi or claude-cli (see the consultant line)")

    const pi = toolVersion("pi")
    add("consultants", "pi", pi ? "ok" : "skip", pi ?? "not installed",
      pi ? "" : "the consultant when codex is missing, and the `extra=pi` lane; without it neither runs pi")

    const gh = toolVersion("gh")
    if (!gh) {
      add("consultants", "gh", "warn", "not installed", "PR mode falls back to a local clone (needs base=; adds git objects, no ref or config), else the .diff by URL")
    } else {
      // Presence is not the failure mode here either — an unauthenticated gh is.
      const auth = sh("gh", ["auth", "status"]) !== null
      add("consultants", "gh", auth ? "ok" : "warn", auth ? gh : `${gh} — not authenticated`,
        auth ? "" : "PR mode falls back to a local clone (needs base=; adds git objects, no ref or config), else the .diff by URL")
    }
  }

  // The same selection the review makes (with `consultant=` mirrored by `--consultant`), so doctor
  // and review name the same lane. `pi --list-models` is a local catalog, not a paid call, so it runs
  // under --offline too; it is only listed (~2 s) when the selection can actually land on pi.
  const wantsPi = forced === "pi" || (!forced && !toolVersion("codex"))
  const piModels = wantsPi && toolVersion("pi") ? listPiModels() : null
  const selection = selectConsultants({
    consultant: forced,
    installed: { codex: Boolean(toolVersion("codex")), pi: Boolean(toolVersion("pi")), claude: Boolean(toolVersion("claude")) },
    piModels,
  })
  const consultant = selection.lanes[0]
  {
    const presence = "selection uses presence only: installed (and, for pi, a listed model) does not mean authenticated, " +
      "and nothing falls back to the next consultant at run time"
    add("consultants", `consultant: ${consultant.name}`, consultant.skip ? "warn" : "ok", selection.reason,
      consultant.skip ? `every review runs single-source; ${presence}` : presence)
  }

  // ── Code graph ───────────────────────────────────────────────────────────────────────────────
  {
    const cli = toolVersion("codegraph")
    add("code graph", "codegraph CLI", cli ? "ok" : "warn", cli ?? "not installed",
      cli ? "" : "blast-radius falls back to grep; `impact`/`callers` is the fast, precise path")

    const codegraphDb = join(REPO, ".codegraph/codegraph.db")
    const graphifyJson = join(REPO, "graphify-out/graph.json")
    const graph = existsSync(codegraphDb) ? codegraphDb : existsSync(graphifyJson) ? graphifyJson : null

    if (!graph) {
      add("code graph", "graph in repo", "warn", "none found",
        "reviewers fall back to grep — supported, but blast-radius is slower and less precise")
    } else {
      const kind = graph === codegraphDb ? "codegraph" : "graphify"
      // A graph reflects its last build. A STALE one is the interesting case: agents are told
      // "absent/stale -> grep", but they have no way to detect staleness from inside a review.
      const lastCommit = Number(sh("git", ["log", "-1", "--format=%ct"], { cwd: REPO }) ?? 0)
      const built = Math.floor(statSync(graph).mtimeMs / 1000)
      const behindDays = lastCommit && built < lastCommit ? Math.floor((lastCommit - built) / 86400) : 0
      if (behindDays >= 1) {
        add("code graph", "graph freshness", "warn",
          `${kind} graph is ${behindDays} day(s) older than the last commit`,
          "a stale graph can point reviewers at code that moved; rebuild it or reviewers should prefer grep")
      } else {
        add("code graph", "graph freshness", "ok", `${kind}, current with HEAD`)
      }
    }
  }

  // ── Contracts and agents (free, and already owned by other scripts) ──────────────────────────
  {
    const problems = lint(ROOT)
    add("contracts", "agents and prompts", problems.length ? "fail" : "ok",
      problems.length ? problems.map((p) => `${p.file}:${p.line} ${p.message}`).join("; ") : "5 agents, vocabulary and dispatch intact",
      problems.length ? "an agent may be undispatchable, or a read-only guarantee may be gone" : "")

    const sync = sh("node", [join(ROOT, "scripts/gen-contracts.mjs"), "--check"], { cwd: ROOT })
    add("contracts", "generated blocks", sync ? "ok" : "fail",
      sync ?? "out of sync with the canonical schema",
      sync ? "" : "a prompt asks for a shape the runtime does not parse")

    // Which model each dimension runs on — they differ since 0.8.3, and that is worth stating.
    // An unset effort follows the session, so it is printed as such rather than guessed.
    const modelOf = (file) => {
      const text = readFileSync(join(ROOT, file), "utf8")
      const model = text.match(/^model:\s*(\S+)/m)?.[1] ?? "?"
      return `${model}/${text.match(/^effort:\s*(\S+)/m)?.[1] ?? "session"}`
    }
    const models = ["arch", "impact", "quality", "test"].map((n) => `${n}=${modelOf(`agents/${n}-reviewer.md`)}`)
    add("contracts", "dimension models", "ok", `${models.join(" ")} verifier=${modelOf("agents/finding-verifier.md")}`,
      "a profile or `models=` / `effort=` may override")

    // Per-invocation effort on subagents arrived in Claude Code 2.1.292; an older CLI ignores it silently.
    const claudeVersion = toolVersion("claude")?.match(/^(\d+)\.(\d+)\.(\d+)/)
    const [major, minor, patch] = claudeVersion ? claudeVersion.slice(1).map(Number) : []
    const isOldClaude = Boolean(claudeVersion) &&
      (major < 2 || (major === 2 && (minor < 1 || (minor === 1 && patch < 292))))
    if (isOldClaude) {
      add("contracts", "claude effort", "warn", `claude ${claudeVersion[0]}: effort= on subagents needs 2.1.292+`,
        "effort= and the agents' effort pins may be ignored, so lanes run at the session's effort")
    }
  }

  // ── Workspace ────────────────────────────────────────────────────────────────────────────────
  {
    const isRepo = sh("git", ["rev-parse", "--is-inside-work-tree"], { cwd: REPO }) === "true"
    add("workspace", "git repository", isRepo ? "ok" : "fail", isRepo ? REPO : `${REPO} is not a git work tree`,
      isRepo ? "" : "there is no diff to review")

    if (isRepo) {
      const hasHead = sh("git", ["rev-parse", "HEAD"], { cwd: REPO }) !== null
      if (!hasHead) add("workspace", "commits", "fail", "no commits yet", "nothing to diff against")

      try {
        accessSync(REPO, constants.W_OK)
        // trailing slash: without it git reports a not-yet-created directory as not ignored
        const ignored = sh("git", ["check-ignore", "-q", ".reviews/"], { cwd: REPO }) !== null
        add("workspace", "report output", "ok",
          ignored ? ".reviews/ writable and gitignored" : ".reviews/ writable, NOT gitignored")
        if (!ignored) {
          add("workspace", ".reviews in git", "warn", "not ignored",
            "review reports would be picked up as untracked changes by the NEXT review; the run archive will be skipped")
        }
      } catch {
        add("workspace", "report output", "warn", "directory is not writable",
          "the report cannot be written; use `no-file` or `out=<path>`")
      }
    }
  }

  // ── Lenses (offline: same D15-checked loading as scripts/lenses.mjs) ─────────────────────────
  let loaded
  try {
    loaded = loadSources({ repo: REPO, sources })
  } catch (error) {
    loaded = { ...loadSources({ sources }), skipped: [], failed: true }
    add("lenses", "project lenses", "warn", String(error.message).split("\n")[0],
      "every /consensus-review run stops (exit 2) until git can check the lens files")
  }
  const profiles = listProfiles(REPO, { sources })

  // ── Sources: one row per user and built-in layer, with its resolved root (direnv may set XDG) ──
  {
    const lensHolder = new Map()
    const shadowed = { user: [], builtin: [] }
    for (const { name, layer } of [...loaded.records, ...loaded.rejected]) {
      if (!name || !layer) continue
      if (!lensHolder.has(name)) lensHolder.set(name, layer)
      else if (lensHolder.get(name) !== layer && shadowed[layer]) shadowed[layer].push(`lens ${name} (by ${lensHolder.get(name)})`)
    }
    for (const { name, layer, shadowedBy } of profiles) {
      if (shadowedBy && shadowed[layer]) shadowed[layer].push(`profile ${name} (by ${shadowedBy})`)
    }
    const reserved = [
      ...loaded.rejected.filter((r) => r.layer === "user" && r.name).map((r) => `lens ${r.name}`),
      ...profiles.filter((p) => p.layer === "user" && p.name && p.error).map((p) => `profile ${p.name}`),
    ]
    for (const [index, layer] of [[0, "user"], [1, "builtin"]]) {
      const kinds = ["lenses", "profiles"].map((kind) => [kind, sourceRoots({ ...sources, repo: REPO, kind })[index]])
      const states = kinds.map(([kind, l]) =>
        `${kind} ${l.failure ? `rejected: ${l.failure}` : l.problem === "absent" ? "none" : l.problem ? `ignored: ${l.problem}` : "ok"}`)
      const names = [...loaded.records.filter((r) => r.layer === layer).map((r) => `lens ${r.name}`),
        ...profiles.filter((p) => p.layer === layer && p.name && !p.error).map((p) => `profile ${p.name}`)]
      const parts = [kinds[0][1].root ?? "no root", ...states]
      if (names.length) parts.push(`loaded: ${names.join(", ")}`)
      if (layer === "user" && reserved.length) parts.push(`reserved (fix the file; a run naming it stops): ${reserved.join(", ")}`)
      if (shadowed[layer].length) parts.push(`shadowed: ${shadowed[layer].join(", ")}`)
      const bad = kinds.some(([, l]) => l.failure || (l.problem && l.problem !== "absent")) || (layer === "user" && reserved.length)
      const none = kinds.every(([, l]) => l.problem === "absent")
      add("sources", layer === "user" ? "user layer" : "built-in layer", bad ? "warn" : none ? "skip" : "ok", parts.join("; "),
        layer === "user"
          ? "user lenses apply like repository lenses and beat them; user profiles beat repository ones"
          : "built-in lenses apply only when named in lenses=; built-in profiles only by profile=")
    }
  }

  {
    const items = loaded.records.filter((r) => r.layer !== "builtin")
    const rejected = loaded.rejected.filter((r) => r.layer !== "builtin")
    const { skipped } = loaded
    if (!loaded.failed && !items.length && !rejected.length && !skipped.length) {
      add("lenses", "project lenses", "skip", "none found", "reviews apply only the generic dimensions")
    }
    const tracked = (sh("git", ["ls-files", "-z"], { cwd: REPO }) ?? "").split("\0").filter(Boolean)
    const userNames = new Set([...loaded.records, ...loaded.rejected].filter((r) => r.layer === "user" && r.name).map((r) => r.name))
    for (const item of items) {
      const label = item.layer === "user" ? `${item.source} ${item.name} (user)` : `${item.source} ${item.name}`
      if (item.layer === "repo" && userNames.has(item.name)) {
        add("lenses", label, "skip", "shadowed by user", "the user lens of this name applies instead (or, rejected, reserves the name)")
        continue
      }
      add("lenses", label, "ok", `${item.source} ${item.dimension ?? "all"}, ${item.include.length} globs`)
      for (const glob of item.layer === "repo" ? item.include : []) {
        if (!tracked.some((path) => instructionMatches(path, { include: [glob], exclude: [] }))) {
          add("lenses", label, "warn", `glob matches no tracked file: ${glob}`,
            "this glob matches no tracked file; the lens fires only for new files it matches")
        }
      }
      for (const key of item.ignoredKeys) {
        add("lenses", label, "warn", `ignored key: ${key}`, "this key has no effect in this version")
      }
    }
    for (const { file, reason } of rejected) {
      add("lenses", file, "warn", reason, "this lens is never applied")
    }
    for (const { file, reason } of skipped) {
      add("lenses", file, "warn", reason === "changed in this diff" ? "modified" : reason,
        "applied only when tracked and unchanged at HEAD; commit it")
    }
  }

  // ── Profiles (offline: the same checks as `settings.mjs profile`, minus the diff) ───────────
  {
    // Built-in profiles and an ignored layer are on the sources rows.
    const own = profiles.filter((p) => p.layer === "repo" || (p.layer === "user" && p.name))
    if (!own.length) {
      add("profiles", "review profiles", "skip", "none found", "a run that names `profile=<name>` uses the built-in one, else stops: no such profile")
    }
    const stops = "this profile stops any run that names it"
    for (const { name, file, layer, values, status, error, shadowedBy } of own) {
      const label = name ? `profile ${name}${layer === "user" ? " (user)" : ""}` : file
      if (shadowedBy) {
        add("profiles", label, "skip", `profile ${name}: shadowed by ${shadowedBy}`, "a run naming it uses the higher layer's file")
      } else if (error) {
        add("profiles", label, "warn", name ? `profile ${name}: ${error}` : error, stops)
      } else if (status !== "ok") {
        add("profiles", label, "warn", `profile ${name}: ${status}`, `${stops} until it is committed`)
      } else {
        const keys = Object.keys(SETTINGS).filter((key) => Object.keys(values).some((k) => k.toLowerCase() === key))
        add("profiles", label, "ok", `${keys.length} keys: ${keys.join(", ")}`)
      }
    }
  }

  // ── Live probes ──────────────────────────────────────────────────────────────────────────────
  if (OFFLINE) {
    add("live", "claude envelope", "skip", "--offline", "stale auth and envelope drift go undetected")
    add("live", "codex schema", "skip", "--offline", "stale auth and schema rejection go undetected")
    if (consultant.name === "claude-cli" && !consultant.skip) {
      add("live", "claude-cli read-only", "skip", "--offline",
        "a claude-cli consultant with a write tool, an MCP server or a live repo hook goes undetected")
    }
  } else {
    const claudeVersion = toolVersion("claude")
    if (!claudeVersion) {
      add("live", "claude envelope", "fail", "claude CLI not found", "/loop-review cannot run at all")
    } else {
      const probe = probeClaude({ root: ROOT })
      const failed = probe.checks.filter(([, pass]) => !pass).map(([label]) => label)
      add("live", "claude envelope", probe.ok ? "ok" : "fail",
        probe.ok ? `${claudeVersion} — 6/6` : `${claudeVersion} — ${probe.state}: ${failed.join(", ")}${probe.detail ? ` (${probe.detail})` : ""}`,
        probe.ok ? "" : "the adapter cannot read what the CLI returns; /loop-review will report failed passes")
    }

    if (!toolVersion("codex")) {
      add("live", "codex schema", "skip", "codex not installed")
    } else {
      const probe = probeCodex({ root: ROOT, repo: REPO })
      add("live", "codex schema", probe.ok ? "ok" : "fail",
        probe.ok ? `accepted the findings schema (${probe.findings} finding(s) on the probe diff)` : probe.reason,
        probe.ok ? "" : "the codex lane will be reported `failed` and its findings lost — a config bug, not a clean review")
    }

    // Only for the lane the review would run: one paid call, on the user's own Claude quota.
    if (consultant.name === "claude-cli" && !consultant.skip) {
      const probe = probeClaudeCli({ root: ROOT })
      add("live", "claude-cli read-only", probe.ok ? "ok" : "fail",
        probe.ok ? `${probe.checks.length}/${probe.checks.length} (one paid call on your Claude quota)` : probe.detail,
        probe.ok ? "" : "the claude-cli consultant is not provably read-only or not working; do not rely on its lane")
    }
  }

  return results
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────
// Only when invoked directly. Without this guard, importing `diagnose` in a test runs the whole
// diagnostic — live probes included — and then calls process.exit(), killing the test runner.
if (process.argv[1] && process.argv[1].endsWith("doctor.mjs")) {
const argv = process.argv.slice(2)
const has = (f) => argv.includes(`--${f}`)
const valueOf = (f, d) => {
  const i = argv.indexOf(`--${f}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d
}
const OFFLINE = has("offline") || has("no-live")
const JSON_OUT = has("json")

const results = diagnose({ root: SELF, repo: valueOf("repo", process.cwd()), offline: OFFLINE, consultant: valueOf("consultant", null) })
const fails = results.filter((r) => r.status === "fail")
const warns = results.filter((r) => r.status === "warn")

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({ ok: fails.length === 0, results }, null, 2) + "\n")
} else {
  const MARK = { ok: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" }
  let section = ""
  for (const r of results) {
    if (r.section !== section) {
      section = r.section
      process.stdout.write(`\n${section}\n`)
    }
    process.stdout.write(`  ${MARK[r.status]}  ${r.label}${r.detail ? ` — ${r.detail}` : ""}\n`)
    if (r.consequence) process.stdout.write(`        ↳ ${r.consequence}\n`)
  }
  process.stdout.write("\n")
  if (fails.length) {
    process.stdout.write(`${fails.length} failing, ${warns.length} warning — reviews will be degraded or will not run.\n`)
  } else if (warns.length) {
    process.stdout.write(`No failures, ${warns.length} warning — reviews will run, with the caveats above.\n`)
  } else {
    process.stdout.write("All checks passed.\n")
  }
  if (OFFLINE) process.stdout.write("Live probes were skipped (--offline); stale auth cannot be detected without them.\n")
}

process.exit(fails.length ? 1 : 0)
}
