# consensus-review

Multi-model **consensus code review** for Claude Code.

Opus acts as **arbiter** and combines its own review with two **independent external consultants** — [`codex`](https://github.com/openai/codex) and [`opencode`](https://opencode.ai) — across four review dimensions. It triages the change by size **and** blast-radius first (so a 2000-line dump of Bruno configs doesn't spin up the whole panel), ranks findings **P0–P2**, supports a **sceptic** pass that tries to refute findings, and uses a **code graph** (graphify / codegraph) for navigation when one is present.

Review is strictly **read-only** — the only thing written is a markdown report under `.omc/reviews/`.

---

## Install

**From GitHub** (after you push this repo):

```
/plugin marketplace add <owner>/consensus-review
/plugin install consensus-review@crv
```

**Locally** (test before pushing):

```
/plugin marketplace add /home/andrii/opencode_sanbox/consensus-review
/plugin install consensus-review@crv
```

`/plugin marketplace add` accepts a local directory or a GitHub `owner/repo`. The marketplace is named `crv`; the plugin is `consensus-review`.

> If you already installed these as **personal** commands/agents in `~/.claude/commands` and `~/.claude/agents`, remove those copies after installing the plugin to avoid duplicate-command collisions.

---

## Prerequisites

External CLIs are **not** auto-installed — install and authenticate the ones you want:

| Tool | Needed for | Notes |
|------|-----------|-------|
| `codex` | the codex consultant lane | required for external review (login via `codex login`) |
| `opencode` | the opencode consultant lane | optional — skip with the `codex-only` flag |
| `gh` | reviewing a PR by URL/number | GitHub CLI, authenticated |

**Optional, auto-detected** (used for faster, more precise navigation — never built automatically):

| Tool | Marker | Used for |
|------|--------|----------|
| [graphify](https://github.com/safishamsi/graphify) | `graphify-out/graph.json` | `explain` / `path` — module map, connectivity |
| [codegraph](https://github.com/colbymchenry/codegraph) | `.codegraph/codegraph.db` | `impact` / `callers` / `callees` — adjacent parts, blast radius |

If neither graph is present (or it's stale), reviewers fall back to normal grep — absence is never reported as a finding.

---

## Commands

> Installed as a plugin, commands are namespaced (e.g. `/consensus-review:consensus-review`); bare names (`/consensus-review`) work when there's no collision.

| Command | What it does |
|---------|--------------|
| `/consensus-review [<PR>] [sceptic] [codex-only] [arch] [deep\|minimal]` | Orchestrated consensus review with triage |
| `/impact-review [<scope>]` | One dimension: correctness + regressions + adjacent parts + security/migrations |
| `/quality-review [<scope>]` | One dimension: maintainability, conventions, AI-slop, duplication, contracts |
| `/test-review [<scope>]` | One dimension: test quality, mock/fixture drift, coverage of critical flows |
| `/arch-review [<scope>]` | One dimension: architectural impact of the change (diff-scoped) |
| `/architecture-audit` | Full **whole-project** architecture audit (heavier; standalone) |

`<scope>` / `<PR>`: empty = uncommitted working tree; a PR URL / `owner/repo#N` / `#N`; a git range (`main..HEAD`); a path/glob.

### `consensus-review` flags

| Flag | Effect |
|------|--------|
| `sceptic` | Adversarial pass that tries to refute each finding (P0s are never silently dropped — only downgraded with a logged reason) |
| `codex-only` | Use only codex as the external consultant (skip opencode) |
| `arch` | Force the architecture dimension even if the change isn't structural |
| `deep` / `full` | Force the full panel + both consultants (skip auto-triage) |
| `minimal` | Force the minimal tier (impact + codex only) |

---

## How it works

1. **Resolve** the diff (PR via `gh pr diff`, or `git diff HEAD` + untracked) into a temp workdir outside the repo.
2. **Triage** — classify the change by *effective code size* (non-code like `.bru`, lock files, docs, fixtures, generated code is excluded from size) and *blast radius* (shared modules / contracts / manifests / migrations / auth / fan-in). This yields a tier:

   | Tier | Trigger | Opus dimension agents | Consultants |
   |------|---------|------------------------|-------------|
   | **T0 trivial** | only non-code | — (panel skipped) | — |
   | **T1 minimal** | small + isolated | impact | codex |
   | **T2 standard** | small/medium + local | impact + quality (+ tests if present) | codex + opencode |
   | **T3 deep** | large / wide blast / structural | + architecture | codex + opencode |

3. **Review** — applicable dimension agents run as read-only subagents (Opus lane); codex + opencode each review independently with a minimal, non-leading brief carrying only the applicable dimensions + severity rubric.
4. **Consensus** — Opus dedups overlaps, tags each finding with `dimension` and an agreement badge `[opus|codex|opencode]`, and assigns the final P0–P2 severity.
5. **Sceptic** (optional) — Opus-only refutation pass; P0s are protected (downgrade-with-annotation, never silent drop); all drops are logged.
6. **Report** — printed to the terminal and saved to `<cwd>/.omc/reviews/review-<slug>-<date>.md`, with a classification header, per-dimension summary, minority/disputed and dropped appendices, and a source-availability section.

---

## Severity

- **P0** — blocker: wrong behavior, security, data loss, crash, breaking change, regression in adjacent code.
- **P1** — important, not a blocker: edge cases, error handling, perf, missing tests for risk.
- **P2** — minor: style, naming, nitpicks, optional refactors.

---

## Notes & limitations

- Cost scales with tier — a structural PR with tests can spin up several Opus agents + codex + opencode. Triage trims this; `codex-only` and omitting `deep` reduce it further.
- The code graph reflects its last build (usually committed state): reviewers use it for existing/surrounding code and the diff itself for brand-new symbols.
- Default review output language is Russian (the dimension agents are authored in RU); identifiers/paths stay in original form.

## License

MIT — see [LICENSE](./LICENSE).
