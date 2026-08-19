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
import { execFileSync } from "node:child_process"
import { existsSync, statSync, readFileSync, accessSync, constants } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { lint } from "./lint-prompts.mjs"
import { probeClaude, probeCodex, toolVersion } from "./lib/probe.mjs"

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
export function diagnose({ root = SELF, repo = process.cwd(), offline = false } = {}) {
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
  {
    const codex = toolVersion("codex")
    add("consultants", "codex", codex ? "ok" : "fail", codex ?? "not installed",
      codex ? "" : "every review runs single-source; the report says so in its Sources line, but nothing stops it")

    const pi = toolVersion("pi")
    add("consultants", "pi", pi ? "ok" : "skip", pi ?? "not installed",
      pi ? "" : "only needed for `extra-advisor`; without it that flag has no second advisor")

    const gh = toolVersion("gh")
    if (!gh) {
      add("consultants", "gh", "warn", "not installed", "PR mode falls back to fetching the .diff by URL")
    } else {
      // Presence is not the failure mode here either — an unauthenticated gh is.
      const auth = sh("gh", ["auth", "status"]) !== null
      add("consultants", "gh", auth ? "ok" : "warn", auth ? gh : `${gh} — not authenticated`,
        auth ? "" : "PR mode falls back to fetching the .diff by URL")
    }
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
    const models = ["arch", "impact", "quality", "test"].map((n) => {
      const f = join(ROOT, `agents/${n}-reviewer.md`)
      return `${n}=${readFileSync(f, "utf8").match(/^model:\s*(\S+)/m)?.[1] ?? "?"}`
    })
    const verifier = readFileSync(join(ROOT, "agents/finding-verifier.md"), "utf8").match(/^model:\s*(\S+)/m)?.[1]
    add("contracts", "dimension models", "ok", `${models.join(" ")} verifier=${verifier}`)
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
        const ignored = sh("git", ["check-ignore", ".reviews"], { cwd: REPO })
        add("workspace", "report output", "ok",
          ignored ? ".reviews/ writable and gitignored" : ".reviews/ writable, NOT gitignored")
        if (!ignored) {
          add("workspace", ".reviews in git", "warn", "not ignored",
            "review reports would be picked up as untracked changes by the NEXT review")
        }
      } catch {
        add("workspace", "report output", "warn", "directory is not writable",
          "the report cannot be written; use `no-file` or `out=<path>`")
      }
    }
  }

  // ── Live probes ──────────────────────────────────────────────────────────────────────────────
  if (OFFLINE) {
    add("live", "claude envelope", "skip", "--offline", "stale auth and envelope drift go undetected")
    add("live", "codex schema", "skip", "--offline", "stale auth and schema rejection go undetected")
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

const results = diagnose({ root: SELF, repo: valueOf("repo", process.cwd()), offline: OFFLINE })
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
