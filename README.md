# consensus-review

Multi-model **consensus code review** for Claude Code. Opus acts as **arbiter** and merges its own review with an independent external consultant — [`codex`](https://github.com/openai/codex) — across four dimensions (architecture / quality / impact / tests), with an optional second advisor [`pi`](https://pi.dev) behind the `extra-advisor` flag. It triages the change by size **and** blast-radius first (so a 2000-line dump of Bruno configs doesn't run the whole panel), ranks findings **P0–P2**, and runs an independent **sceptic** verifier by default (strict: verifier + consultant refuters with a majority vote). Strictly **read-only** — the only write is a report under `.reviews/`.

> **No `oh-my-claudecode` required.** This is a standalone plugin — the only hard needs are the external CLIs below. **`codegraph` is strongly recommended:** its `impact`/`callers` gives fast, precise blast-radius, which is a killer feature for review.

## Install

```
# from GitHub
/plugin marketplace add akholod/consensus-review
/plugin install consensus-review@crv

# or from a local clone (for development)
/plugin marketplace add /path/to/consensus-review
/plugin install consensus-review@crv
```

Marketplace = `crv`, plugin = `consensus-review`. Commands install namespaced (`/consensus-review:consensus-review`); bare names work when there's no collision. If you already keep these as personal `~/.claude` commands/agents, remove them after installing to avoid duplicates.

## Prerequisites (external — not auto-installed)

| Tool | Required? | Install |
|------|-----------|---------|
| `codex` | for the codex lane (the baseline external consultant) | see openai/codex; `codex login` |
| `pi` | optional — only for the `extra-advisor` lane | see [pi.dev](https://pi.dev) |
| `gh` | only for PR-by-URL/number mode | GitHub CLI, authenticated |
| `codegraph` | **strongly recommended** — its `impact`/`callers` powers fast, precise blast-radius | `npm i -g @colbymchenry/codegraph` then `codegraph init` |
| `graphify` | optional — `explain`/`path` for module maps | `uv tool install graphifyy` (pip pkg is `graphifyy`) |

Code graphs are **auto-detected and used, never built** by this plugin. None present → reviewers fall back to grep (absence is never a finding). Detection: `.codegraph/codegraph.db` / `graphify-out/graph.json`.

## Commands

| Command | Purpose |
|---------|---------|
| `/consensus-review [<PR>] [sceptic=off\|basic\|strict] [extra-advisor[=<model>]] [arch] [deep\|minimal] [lang=en\|ua]` | Orchestrated consensus review with triage |
| `/impact-review [<scope>]` | Correctness + regressions + adjacent parts + security/migrations |
| `/quality-review [<scope>]` | Maintainability, conventions, AI-slop, duplication, contracts |
| `/test-review [<scope>]` | Test quality, mock/fixture drift, critical-flow coverage |
| `/arch-review [<scope>]` | Architectural impact of the change (diff-scoped) |
| `/architecture-audit` | Full **whole-project** architecture audit (standalone, heavier) |

`<scope>`/`<PR>`: empty = uncommitted working tree; a PR URL / `owner/repo#N` / `#N`; a git range (`main..HEAD`); a path/glob. Standalone commands also take `lang=en|ua`.

### `consensus-review` flags

| Flag | Effect |
|------|--------|
| _(default)_ | **Sceptic runs strict by default** — an **independent verifier** (fresh context, not the reviewers or the arbiter) refutes each P0/P1 with evidence **and** the consultants are re-run as refuters for a majority vote per finding (a tie is not a confirmation, so with the default two voters a finding needs both to survive). Unconfirmed findings move to Unconfirmed/Unverified buckets; P0s never silently dropped. Fires only when there are P0/P1 findings, so clean/trivial reviews pay nothing. |
| `sceptic=basic` | Verifier only — no refuter re-runs, no vote (the pre-0.5 default) |
| `sceptic=off` | Disable the sceptic pass entirely (`no-sceptic` is a kept alias) |
| `extra-advisor[=<model>]` | Add `pi` as a **second** external consultant (off by default — codex alone otherwise). `extra-advisor=<model>` picks pi's model, e.g. `extra-advisor=sonnet:high` |
| `arch` | Force the architecture dimension even if the change isn't structural |
| `deep` / `full` | Force the full panel + both consultants (skip triage) |
| `minimal` | Force the minimal tier (impact + codex only) |
| `lang=en\|ua` | Output language — English (default) or Ukrainian |

## How it works

1. **Resolve** the diff (PR via `gh pr diff`, or `git diff HEAD` + untracked) into a temp workdir outside the repo.
2. **Triage** by *effective code size* (non-code like `.bru`, lock files, docs, fixtures, generated code is excluded) and *blast radius* (shared modules / contracts / manifests / migrations / auth / fan-in — fan-in measured via `codegraph impact`/`callers` when present). → a tier:

   | Tier | Trigger | Opus agents | Consultants |
   |------|---------|-------------|-------------|
   | **T0** | only non-code | — (skipped) | — |
   | **T1** | small + isolated | impact | codex |
   | **T2** | small/medium + local | impact + quality (+ tests if present) | codex |
   | **T3** | large / wide blast / structural | + architecture | codex |

   `extra-advisor` adds `pi` as a second consultant at any tier above T0.

3. **Review** — applicable dimension agents run read-only (Opus lane); codex (and pi, with `extra-advisor`) review independently from a minimal, non-leading brief. The Opus agents and codex may use the code graph for navigation; pi runs with a shell-less read-only toolset (`read,grep,find,ls`), so it navigates by reading and grepping.
4. **Consensus** — Opus dedups, tags each finding with `dimension` + an agreement badge `[opus|codex|pi]`, assigns final **P0** (blocker) / **P1** (important) / **P2** (minor).
5. **Sceptic** (strict by default) — an **independent verifier agent** (fresh context, separate from the reviewers *and* the arbiter, so it can't rubber-stamp its own findings) refutes each P0/P1 with evidence; strict (the default) adds a majority vote across the consultants; `sceptic=basic` keeps the verifier alone. P0s are never silently dropped; unconfirmed findings move to explicit buckets; all drops logged.
6. **Report** — terminal + `<cwd>/.reviews/review-<slug>-<date>.md` with classification header, per-dimension summary, unconfirmed/unverified + dropped appendices, source availability.

## Notes

- Cost scales with tier; triage and omitting `extra-advisor`/`deep` keep it down.
- **Pick a different model for `extra-advisor`.** A second consultant is only worth its cost if it is a *different* model — if `pi` is configured to run the same engine as `codex` (`openai-codex` / `gpt-5.x`, a common default), the extra lane mostly echoes codex. Use `extra-advisor=<model>` (e.g. `sonnet:high`, `gemini-2.5-pro`) or set another default in `~/.pi/agent/settings.json`. The report prints pi's resolved provider/model and flags the collision.
- A code graph reflects its last build (usually committed state): used for existing/surrounding code, the diff itself for brand-new symbols.

## License & attribution

This plugin: **MIT** (see [LICENSE](./LICENSE)).

`codex`, `pi`, `codegraph` ([MIT](https://github.com/colbymchenry/codegraph)), and `graphify` ([MIT](https://github.com/safishamsi/graphify)) are **separate tools, not bundled or redistributed here** — the plugin only detects and invokes them if you install them. Their MIT licenses place no restriction on this plugin. (A Claude Code plugin ships commands/agents/skills/hooks/MCP, not external binaries, so it can't auto-install them — install them yourself via the table above.)
