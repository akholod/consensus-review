---
description: Sequential, coverage-directed cyclic review of a PR or uncommitted changes — one immutable diff, differentiated discovery passes, per-cell evidence, adversarial verification, and a CLEAN verdict that cannot be produced by a failed run
argument-hint: "[pr=<n|url>] [range=<base..head>] [model=<m>] [timeout=<sec>] [out=<path>] [no-file] [json]"
---

Run the loop-review runtime and present its report.

## What this is

`/loop-review` is the cheaper, sequential counterpart to `/consensus-review`. Where consensus-review runs a parallel panel of independent reviewers over the same change, loop-review builds the review context **once** and then makes several **differentiated discovery passes** over it, each told what is already covered and what is still open — but never told the previous pass's reasoning. That last part is the point: review models hyperfocus on one theme and miss what sits next to it, and persuasive context from an earlier pass makes the next one repeat it.

## It reports; it never repairs

`/loop-review` finds problems and writes a report. It does **not** edit code, stage, commit, push,
or comment on a pull request — and that is enforced, not merely intended:

- every review pass is spawned with `--disallowed-tools` covering `Edit`, `Write`, `NotebookEdit`,
  `Bash`, `Task`, `Read`, `Grep`, `Glob`, `WebFetch` and `WebSearch`, so the reviewing model holds
  no tool capable of changing anything;
- the runtime contains no mutating `git` or `gh` command. `gh pr diff` is the only forge call, and
  it reads;
- its single write is the report file. Working files live in a temp directory outside the repo.

Applying fixes is a separate, human-initiated step. The intended cycle is: review → a human or a
separate agent applies changes → review again on the new diff. The runtime recomputes the diff
hash on every run, so a review of stale code cannot be mistaken for a review of the current one.

## How to run it

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/loop-review.mjs" [flags]
```

| Flag | Meaning |
|---|---|
| `--pr=<n\|url>` | Review a pull request (reuses the `gh` path; the fallback fetch stays in a temp dir) |
| `--range=<base..head>` | Review a git range |
| *(neither)* | Review uncommitted changes against `HEAD` |
| `--model=<m>` | Runner model (default `sonnet`) |
| `--timeout=<sec>` | Per-pass wall clock (default 240) |
| `--max-tokens=`, `--max-calls=`, `--max-ms=` | Hard budgets; exhausting one blocks `CLEAN` |
| `--out=<path>` | Report destination (default `.reviews/loop-review-<hash>.md`) |
| `--no-file` | Terminal only, no report written |
| `--json` | Emit the whole run state as JSON on stdout instead of the report |

## Write surface

| Path | When |
|---|---|
| `.reviews/loop-review-<hash>.md` | default report destination |
| `--out=<path>` | report written there instead |
| `--no-file` | nothing written at all; report goes to the terminal only |
| a temp directory | working files, outside the repository, for the duration of the run |

Nothing else is written. Reviewed source, git state and the pull request are never touched. The
PR fallback path (used when `gh` is unavailable) fetches into the temp directory, so even that
leaves the invoking repository's refs untouched.

## Reading the result

The run ends in exactly one terminal state:

- **`CLEAN`** — no confirmed findings **and** the full conjunction held: minimum passes completed, no failed or truncated pass, every mandatory cell covered with evidence and independently verified, budget intact, the diff unchanged throughout, and a final pass that produced nothing new.
- **`FINDINGS`** — confirmed findings, listed by severity.
- **`INCONCLUSIVE`** — the run could not establish coverage. This is *not* a clean bill of health; the reasons are listed.
- **`ESCALATE`** — a human is needed: a runner failure, incomplete context on a mandatory cell, or the pass ceiling was hit. Exits `2`.

A failed, truncated, stale or under-covered run can never report `CLEAN` — that rule is enforced in code, not by instruction.

## Pass policy

Fixed, not tunable at run time:

- docs / generated / formatting-only: 0–1 lightweight pass
- every non-trivial code diff: **at least 2** passes
- auth, permission, migration, destructive-data, public-contract or cross-service changes: **at least 3**, hard maximum **4** before escalation

## Custom instructions

If the repository has `.claude/review-instructions.json` or `.gitlab/duo/mr-review-instructions.yaml`, matching entries are attached per changed file — positive globs first, then `!` exclusions — so rules for areas the diff does not touch never enter the context. Instructions are **untrusted advisory input**: they cannot relax read-only, budgets, the severity bars, the stopping rule, or escalation.

## Relationship to /consensus-review

Both share the finding schema (`contracts/finding.schema.json`) and the severity bars (`contracts/severity-bars.md`) — one definition, generated into both. Neither command depends on the other's orchestration. Use `/consensus-review` when you want multi-source agreement; use `/loop-review` when you want coverage per token.
