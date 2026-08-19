---
description: Diagnose the consensus-review setup — consultants, code graph, contracts and live probes — and say what a broken piece would silently do to a review
argument-hint: "[offline] [repo=<path>] [json]"
---

Run the diagnostic and present its output.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" [--offline] [--repo <path>] [--json]
```

Flags map straight through: `offline` → `--offline`, `repo=<path>` → `--repo <path>`, `json` → `--json`. As everywhere in this plugin, a leading `--` is also accepted.

## What it is for

**This review degrades silently, on purpose.** An unavailable consultant marks its lane
`unavailable` and the run continues. If every consultant fails, the floor case builds the report
from the Claude lane alone and does not abort. `gh` missing falls back to fetching the diff by URL.
Each of those is right at run time — a partial review beats none — but together they mean a
misconfigured setup yields a report that *looks* complete and is quietly weaker.

So every check here reports what a non-`PASS` state **does to a review**, not just that something
is off. That consequence line is the point of the command.

## It checks function, not presence

`codex --version` succeeds with expired auth and with a schema codex would reject — the exact
failure §6 of `/consensus-review` calls *"a config bug to fix, not a clean review"*. So the live
probe actually runs `codex exec` read-only against this plugin's real findings schema, with stdin
closed, exactly as a review does. Likewise the `claude` probe sends the production discovery prompt
and validates the envelope the adapter parses.

**Live probes run by default and cost real calls** (roughly a minute, two small model calls). Pass
`offline` to skip them — the rest is instant and free, but stale auth cannot be detected without
them, and the summary says so.

## Sections

| Section | Catches |
|---|---|
| plugin | version skew against the latest release; Node below the required 20 |
| consultants | `codex` missing (every review becomes single-source), `pi`, `gh` present **and authenticated** |
| code graph | `codegraph` CLI, a graph in the repo, and whether that graph is **older than the last commit** — agents are told "absent/stale → grep" but cannot detect staleness from inside a review |
| contracts | the five agents resolve and keep their read-only guarantee; generated prompt blocks match the canonical schema; which model each dimension runs on |
| workspace | a git work tree with commits; `.reviews/` writable and ignored — an unignored report becomes an untracked change the *next* review picks up |
| live | the `claude -p` envelope, and codex accepting our schema |

Exit code is `1` when anything is `FAIL`, `0` otherwise; `WARN` never fails the command.
