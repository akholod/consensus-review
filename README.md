# consensus-review

Multi-model **consensus code review** for Claude Code. Opus acts as **arbiter** and merges its own review with two independent external consultants — [`codex`](https://github.com/openai/codex) and [`opencode`](https://opencode.ai) — across four dimensions (architecture / quality / impact / tests). It triages the change by size **and** blast-radius first (so a 2000-line dump of Bruno configs doesn't run the whole panel), ranks findings **P0–P2**, and supports a **sceptic** pass. Strictly **read-only** — the only write is a report under `.reviews/`.

> **No `oh-my-claudecode` required.** This is a standalone plugin. The only hard needs are the external CLIs below. (If the built-in `code-review-expert` skill is present it's used opportunistically, but it's optional.)

## Install

```
# from GitHub (after you push)
/plugin marketplace add <owner>/consensus-review
/plugin install consensus-review@crv

# or locally (test before pushing)
/plugin marketplace add /home/andrii/opencode_sanbox/consensus-review
/plugin install consensus-review@crv
```

Marketplace = `crv`, plugin = `consensus-review`. Commands install namespaced (`/consensus-review:consensus-review`); bare names work when there's no collision. If you already keep these as personal `~/.claude` commands/agents, remove them after installing to avoid duplicates.

## Prerequisites (external — not auto-installed)

| Tool | Required? | Install |
|------|-----------|---------|
| `codex` | for the codex lane (the baseline external consultant) | see openai/codex; `codex login` |
| `opencode` | optional (skip with `codex-only`) | see opencode.ai |
| `gh` | only for PR-by-URL/number mode | GitHub CLI, authenticated |
| `codegraph` | **recommended** — its `impact`/`callers` powers fast, precise blast-radius | `npm i -g @colbymchenry/codegraph` then `codegraph init` |
| `graphify` | optional — `explain`/`path` for module maps | `uv tool install graphifyy` (pip pkg is `graphifyy`) |

Code graphs are **auto-detected and used, never built** by this plugin. None present → reviewers fall back to grep (absence is never a finding). Detection: `.codegraph/codegraph.db` / `graphify-out/graph.json`.

## Commands

| Command | Purpose |
|---------|---------|
| `/consensus-review [<PR>] [sceptic] [codex-only] [arch] [deep\|minimal] [lang=en\|ua]` | Orchestrated consensus review with triage |
| `/impact-review [<scope>]` | Correctness + regressions + adjacent parts + security/migrations |
| `/quality-review [<scope>]` | Maintainability, conventions, AI-slop, duplication, contracts |
| `/test-review [<scope>]` | Test quality, mock/fixture drift, critical-flow coverage |
| `/arch-review [<scope>]` | Architectural impact of the change (diff-scoped) |
| `/architecture-audit` | Full **whole-project** architecture audit (standalone, heavier) |

`<scope>`/`<PR>`: empty = uncommitted working tree; a PR URL / `owner/repo#N` / `#N`; a git range (`main..HEAD`); a path/glob. Standalone commands also take `lang=en|ua`.

### `consensus-review` flags

| Flag | Effect |
|------|--------|
| `sceptic` | Adversarial pass that tries to refute findings (P0s are never silently dropped — only downgraded with a logged reason) |
| `codex-only` | Use only codex as the external consultant (skip opencode) |
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
   | **T2** | small/medium + local | impact + quality (+ tests if present) | codex + opencode |
   | **T3** | large / wide blast / structural | + architecture | codex + opencode |

3. **Review** — applicable dimension agents run read-only (Opus lane); codex + opencode each review independently from a minimal, non-leading brief. All three may use the code graph for navigation.
4. **Consensus** — Opus dedups, tags each finding with `dimension` + an agreement badge `[opus|codex|opencode]`, assigns final **P0** (blocker) / **P1** (important) / **P2** (minor).
5. **Sceptic** (optional) — Opus-only refutation; P0s protected; all drops logged.
6. **Report** — terminal + `<cwd>/.reviews/review-<slug>-<date>.md` with classification header, per-dimension summary, minority/disputed + dropped appendices, source availability.

## Notes

- Cost scales with tier; triage, `codex-only`, and omitting `deep` keep it down.
- A code graph reflects its last build (usually committed state): used for existing/surrounding code, the diff itself for brand-new symbols.

## License & attribution

This plugin: **MIT** (see [LICENSE](./LICENSE)).

`codex`, `opencode`, `codegraph` ([MIT](https://github.com/colbymchenry/codegraph)), and `graphify` ([MIT](https://github.com/safishamsi/graphify)) are **separate tools, not bundled or redistributed here** — the plugin only detects and invokes them if you install them. Their MIT licenses place no restriction on this plugin. (A Claude Code plugin ships commands/agents/skills/hooks/MCP, not external binaries, so it can't auto-install them — install them yourself via the table above.)
