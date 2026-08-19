# consensus-review

Multi-model **consensus code review** for Claude Code. Opus acts as **arbiter** and merges its own review with an independent external consultant — [`codex`](https://github.com/openai/codex) — across four dimensions (architecture / quality / impact / tests), with an optional second advisor [`pi`](https://pi.dev) behind the `extra-advisor` flag. It triages the change by size **and** blast-radius first (so a 2000-line dump of Bruno configs doesn't run the whole panel), ranks findings **P0–P2**, and runs an independent **sceptic** verifier by default (strict: verifier + consultant refuters with a majority vote). Strictly **read-only** — the only write is the report (`.reviews/` by default, `out=<path>` to redirect, `no-file` for none at all).

It ships two review strategies. `/consensus-review` is the **parallel** one — several independent reviewers plus an external consultant, merged by an arbiter, for multi-source agreement. `/loop-review` is the **sequential** one — the context is built once and reviewed in several differentiated passes, each told what is already covered but never *why*, because review models hyperfocus on one theme and miss what sits beside it. Use consensus-review when you want agreement; use loop-review when you want coverage per token.

> **Check your setup with `/doctor`.** It reports what each missing or misconfigured piece would *silently* do to a review — an unavailable consultant does not stop a run, it just makes it quieter. Live probes are on by default (about a minute, two small model calls); `offline` skips them.
>
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
| `/consensus-review [<PR>] [deep\|minimal] [dims=<list>\|arch] [sceptic=off\|basic\|strict] [extra-advisor[=<model>]] [timeout=<sec>] [p2=grouped\|full\|off] [out=<path>\|no-file] [lang=en\|ua\|ru]` | Orchestrated consensus review with triage |
| `/impact-review [<scope>]` | Correctness + regressions + adjacent parts + security/migrations |
| `/quality-review [<scope>]` | Maintainability, conventions, AI-slop, duplication, contracts |
| `/test-review [<scope>]` | Test quality, mock/fixture drift, critical-flow coverage |
| `/arch-review [<scope>]` | Architectural impact of the change (diff-scoped) |
| `/architecture-audit` | Full **whole-project** architecture audit (standalone, heavier) |
| `/loop-review [--pr=<n>\|--range=<a..b>] [--model=<m>] [--timeout=<sec>] [--out=<path>\|--no-file] [--json]` | Sequential, coverage-directed cyclic review (see below) |

`<scope>`/`<PR>`: empty = uncommitted working tree; a PR URL / `owner/repo#N` / `#N`; a git range (`main..HEAD`); a path/glob. Standalone commands also take `lang=en|ua|ru`.

### `consensus-review` flags

Every flag is accepted with or without a leading `--`. Depth (`deep`/`minimal`) and lanes (`dims=`/`arch`) are **orthogonal axes**: `minimal arch` is a shallow architecture-aware pass, not a contradiction. Unrecognized tokens are ignored but echoed in the report header as `Ignored args`, so a typo never passes for a default.

| Flag | Effect |
|------|--------|
| _(default)_ | **Sceptic runs strict by default** — an **independent verifier** (fresh context, not the reviewers or the arbiter) refutes each P0/P1 with evidence **and** the consultants are re-run as refuters for a majority vote per finding (a tie is not a confirmation, so with the default two voters a finding needs both to survive). Unconfirmed findings move to Unconfirmed/Unverified buckets; P0s never silently dropped. Fires only when there are P0/P1 findings, so clean/trivial reviews pay nothing. |
| `sceptic=basic` | Verifier only — no refuter re-runs, no vote (the pre-0.5 default) |
| `sceptic=off` | Disable the sceptic pass entirely (`no-sceptic` is a kept alias) |
| `extra-advisor[=<model>]` | Add `pi` as a **second** external consultant (off by default — codex alone otherwise). `extra-advisor=<model>` picks pi's model, e.g. `extra-advisor=sonnet:high` |
| `arch` | Alias for `dims=+architecture` — force the architecture lane even if the change isn't structural |
| `dims=<list>` | Set the lanes explicitly. Absolute (`dims=impact,quality`) replaces the tier's set; relative (`dims=+tests,-quality`) adjusts it. `dims=+tests` is the only way to review tests when the diff has no test files |
| `deep` / `full` | Force the maximum tier (full panel, skip triage). Wins over `minimal` if both are given |
| `minimal` | Force the minimal tier (shallow exploration budget) |
| `timeout=<sec>` | Per-consultant wall clock for codex/pi. Default `240`, clamped to `[30, 1800]` — raise it on a large PR instead of losing the lane to a timeout |
| `p2=grouped\|full\|off` | P2 presentation. `grouped` (default) shows 7 and rolls the rest up by theme; `full` lists all; `off` suppresses the body but keeps the count |
| `out=<path>` | Report destination (directory or exact file). Default `<cwd>/.reviews/review-<slug>-<date>.md` |
| `no-file` | Terminal output only — the run performs zero writes on disk |
| `lang=en\|ua\|ru` | Output language — English (default), Ukrainian, or Russian |

## How it works

1. **Resolve** the diff (PR via `gh pr diff`, or `git diff HEAD` + untracked) into a temp workdir outside the repo.
2. **Triage** by *effective code size* (non-code like `.bru`, lock files, docs, fixtures, generated code is excluded) and *blast radius* (shared modules / contracts / manifests / migrations / auth / fan-in — fan-in measured via `codegraph impact`/`callers` when present). → a tier:

   | Tier | Trigger | Claude agents | Consultants |
   |------|---------|-------------|-------------|
   | **T0** | only non-code | — (skipped) | — |
   | **T1** | small + isolated | impact | codex |
   | **T2** | small/medium + local · medium + isolated · **small + wide** (no high-risk path) | impact + quality (+ tests if present) | codex |
   | **T3** | large · structural · wide at medium+ · **any size touching a high-risk path** | + architecture | codex |

   **Proportionality:** blast radius decides *which* lane you cannot skip, effective size decides *how many* lanes are worth paying for. A 20-line edit to a shared module needs consumer tracing (impact), not an architecture verdict. The exception is **high-risk paths** — migrations, auth/permissions/security, dependency manifests — which stay T3 at any size, because their failure mode does not scale with line count. `isolated` also covers an edit confined to one file whose changed symbols have no consumers outside it, so small local edits can reach T1 instead of piling up at T2.

   `extra-advisor` adds `pi` as a second consultant at any tier above T0.

3. **Review** — applicable dimension agents run read-only (Claude lane); codex (and pi, with `extra-advisor`) review independently from a minimal, non-leading brief. The dimension agents and codex may use the code graph for navigation; pi runs with a shell-less read-only toolset (`read,grep,find,ls`), so it navigates by reading and grepping.
4. **Consensus** — Opus dedups, tags each finding with `dimension` + an agreement badge `[claude|codex|pi]`, assigns final **P0** (blocker) / **P1** (important) / **P2** (minor). Two rules keep the severities honest:
   - **Evidence bar / admission bar.** Both bars live in every lane — the four agent prompts and the consultant brief alike, so they hold in the standalone commands too. Every P0/P1 needs a concrete failure scenario; one that cannot produce it goes to *Unverified*, **not** down into P2. Every P2 in turn must name the concrete cost of leaving it *and* a project-specific anchor (a documented convention, an existing pattern, a contract) — a remark justified only by a general best practice is not a finding. Without both halves P2 becomes a landfill for unproven claims, which is what turns it into twenty entries of noise.
   - **`owner:` tags.** A lane may report something outside its own protocol (quality spotting a probable bug it cannot trace to consumers) and tag the owning lane. If that lane ran, normal dedup applies; if it did not — architecture is absent at T2, and `dims=` can narrow the panel further — the finding keeps the reporter's severity and is marked *ungraded*. A finding is never lost because the lane that owns it was skipped.
5. **Sceptic** (strict by default) — an **independent verifier agent** (fresh context, separate from the reviewers *and* the arbiter, so it can't rubber-stamp its own findings) refutes each P0/P1 with evidence; strict (the default) adds a majority vote across the consultants; `sceptic=basic` keeps the verifier alone. P0s are never silently dropped; unconfirmed findings move to explicit buckets; all drops logged.
6. **Report** — terminal + `<cwd>/.reviews/review-<slug>-<date>.md` (or `out=<path>`; nothing written with `no-file`), with classification header, per-dimension summary, unconfirmed/unverified + dropped appendices, and source availability. P2 is grouped by default: up to 7 entries individually, the rest rolled up per theme with counts and files — presentation only, `Totals` always keeps the true count.

## `/loop-review` — the sequential strategy

Where `/consensus-review` runs a panel in parallel, `/loop-review` builds the review context **once** and makes several **differentiated discovery passes** over it. Each later pass receives compact fingerprints of what has already been claimed, what has been refuted, and which risk cells are still open — and **never** the previous pass's reasoning. Withholding the reasoning is the mechanism, not an oversight: persuasive context is what makes the next pass restate the dominant theme instead of looking elsewhere.

**It reports; it never repairs.** `/loop-review` finds problems and writes a report. It does not
edit code, stage, commit, push, or comment on a pull request. This is enforced at the process
level, not by asking nicely: each review pass is spawned with `--disallowed-tools` covering
`Edit`, `Write`, `NotebookEdit`, `Bash`, `Task`, `Read`, `Grep`, `Glob`, `WebFetch` and
`WebSearch`, so the model performing the review has no tool with which to change anything. The
runtime itself contains no mutating git or `gh` command; `gh pr diff` is the only forge call and
it reads. Fixing is a separate, human-initiated step — apply the changes, then run the review
again on the new diff.

Its **one** write is the report file (`.reviews/loop-review-<hash>.md` by default, `--out=<path>`
to redirect, `--no-file` for no write at all). Working files live in a temp directory outside the
repository.

It is implemented as a runtime rather than a prompt, because its central promise — that `CLEAN` means something — is a control-flow guarantee:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/loop-review.mjs" [--pr=<n>] [--range=<a..b>] [--no-file]
```

**Terminal states.** `CLEAN` · `FINDINGS` · `INCONCLUSIVE` · `ESCALATE` (exit `2`). `CLEAN` requires the full conjunction: the minimum passes completed, no failed or truncated pass, every mandatory cell covered *with evidence* and independently verified, every actionable finding adjudicated, budget intact, the diff unchanged throughout, and a final pass that produced nothing new. A failed, truncated, stale or under-covered run cannot report `CLEAN` — enforced in code, not by instruction.

**Pass policy** (fixed, not tunable at run time): 0–1 pass for docs/generated/formatting-only; **≥2** for any non-trivial code diff; **≥3** when the change touches auth, permissions, migrations, destructive data, a public contract or crosses services; hard maximum **4** before escalation.

**Coverage cells** are `changed surface × risk category`, derived from the changed paths. A pass must return an evidence record per cell — anchors it actually inspected and checks it actually ran. A cell claimed as covered with no anchors is rejected: dispatch is not coverage.

**Custom instructions.** `.claude/review-instructions.json` or `.gitlab/duo/mr-review-instructions.yaml`, matched per changed file (positive globs, then `!` exclusions), so rules for untouched areas never enter the context. They are untrusted advisory input and cannot relax read-only, budgets, the severity bars, the stopping rule, or escalation.

**Cost.** Roughly **$0.28** per review on a small clean diff (2 passes) and **$0.70–0.88** when there are findings (3 passes plus verification). Those are `total_cost_usd` as the CLI reports it — the API-price valuation of the tokens used. On an API plan that is a bill; on a claude.ai subscription it is drawn against your usage limit instead. Either way it scales with the pass count, because the static context is **not** cached across passes — see `docs/loop-review-measurements.md`, where that hypothesis was tested and refuted.

**Machine-readable output.** `--json` prints the whole run state to stdout — terminal state and
its reasons, every finding with its verdict, every cell with its evidence and verification, each
pass with its state, model and token usage, and the totals. Nothing is written to a log file; if
you want the run recorded, redirect that stdout yourself.

**Shared contracts.** Both commands use one finding schema (`contracts/finding.schema.json`) and one set of severity bars (`contracts/severity-bars.md`). The schema embedded in `commands/consensus-review.md` is generated from the canonical file by `scripts/gen-contracts.mjs`, and CI fails if the two drift.

## Notes

- Cost scales with tier. Triage does most of the work; `minimal` forces the floor, and omitting `extra-advisor`/`deep` keeps it down. Strict sceptic (the default) adds one extra codex run, but only on reviews that actually produced P0/P1 findings.
- **Pick a different model for `extra-advisor`.** A second consultant is only worth its cost if it is a *different* model — if `pi` is configured to run the same engine as `codex` (`openai-codex` / `gpt-5.x`, a common default), the extra lane mostly echoes codex. Use `extra-advisor=<model>` (e.g. `sonnet:high`, `gemini-2.5-pro`) or set another default in `~/.pi/agent/settings.json`. The report prints pi's resolved provider/model and flags the collision.
- A code graph reflects its last build (usually committed state): used for existing/surrounding code, the diff itself for brand-new symbols.

## License & attribution

This plugin: **MIT** (see [LICENSE](./LICENSE)).

`codex`, `pi`, `codegraph` ([MIT](https://github.com/colbymchenry/codegraph)), and `graphify` ([MIT](https://github.com/safishamsi/graphify)) are **separate tools, not bundled or redistributed here** — the plugin only detects and invokes them if you install them. Their MIT licenses place no restriction on this plugin. (A Claude Code plugin ships commands/agents/skills/hooks/MCP, not external binaries, so it can't auto-install them — install them yourself via the table above.)
