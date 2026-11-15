---
description: Sequential, coverage-directed cyclic review of a PR or uncommitted changes — one immutable diff, differentiated discovery passes, per-cell evidence, adversarial verification, and a CLEAN verdict that cannot be produced by a failed run
argument-hint: "[pr=<n|url>] [range=<base..head>] [model=<m>] [timeout=<sec>] [out=<path>] [no-file] [no-archive] [json]"
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
- the runtime changes no ref, `FETCH_HEAD` or config, and `gh pr diff` is the only forge call. Without
  `gh`, a `--pr` through a local clone fetches its commits into this repository's object store
  (even with `--no-file`);
- it writes only the report and its private run archive in the ignored `.reviews/` (`--no-archive`
  drops the archive; `--no-file` writes neither). Working files live in a temp directory outside the repo.

Applying fixes is a separate, human-initiated step. The intended cycle is: review → a human or a
separate agent applies changes → review again on the new diff. The runtime recomputes the diff
hash on every run, so a review of stale code cannot be mistaken for a review of the current one.

## How to run it

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/loop-review.mjs" [flags]
```

| Flag | Meaning |
|---|---|
| `--pr=<n\|url>` | Review a pull request (reuses the `gh` path; the gh-less clone fallback adds git objects to the reviewed clone, never a ref, `FETCH_HEAD` or config). Repeat it (`--pr=acme/api#7 --pr=acme/web#5`) to review several PRs of different repositories as **one feature**: one diff, one report, each PR's paths under its checkout's directory (in the folder, or next to the current repository), else under its repository name |
| `--base=<branch>` | The branch the PR targets; without `gh`, a PR from a local clone needs it (and stops otherwise) |
| `--range=<base..head>` | Review a git range |
| *(neither)* | Review uncommitted changes against `HEAD`. Run from a folder that is not a repository but holds several, it reviews all their uncommitted changes as **one feature** (workspace mode), paths prefixed by the repository directory |
| `--model=<m>` | Runner model (default `sonnet`) |
| `--timeout=<sec>` | Per-pass wall clock (default 240) |
| `--max-tokens=`, `--max-calls=`, `--max-ms=` | Hard budgets; exhausting one blocks `CLEAN` |
| `--out=<path>` | Report destination (default `.reviews/loop-review-<hash>.md`) |
| `--no-file` | Terminal only, no report written (no archive either) |
| `--no-archive` | Do not write the run archive |
| `--json` | Emit the whole run state as JSON on stdout instead of the report |

## Write surface

| Path | When |
|---|---|
| `.reviews/loop-review-<hash>.md` | default report destination |
| `.reviews/<run-id>/` | private run archive (diff, prompts, raw output, findings, events); only when git ignores `.reviews/`; never written next to `--out`; off with `--no-archive` |
| `--out=<path>` | report written there instead |
| `--no-file` | no report and no archive; report goes to the terminal only |
| a temp directory | working files, outside the repository, for the duration of the run |

Nothing else is written, with one exception: the PR fallback path from a local clone (used when
`gh` is unavailable) fetches the PR's objects into the reviewed clone's object store. It never
writes a ref, `FETCH_HEAD` or config. Reviewed source, the working tree and the pull request are
never touched.

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

## A feature across repositories

Workspace mode and several `--pr` review one feature, never one report per repository. No repository lenses apply there (no single repository owns the run; user and built-in lenses still do), no originals are read (there is no single base), and the archive is written only when the invoking directory is a git repository that ignores `.reviews/`. A `#N` without its repository, two PRs of one repository, or a bare `--pr` stops the run with exit 2. A PR without a checkout is reviewed under `@<owner>/<repo>/…`. Without `gh`, each PR comes over its public diff URL; `--base` (the local-clone path, which fetches objects into that checkout's object store, never a ref, `FETCH_HEAD` or config) applies only when exactly one PR has a checkout, since one branch cannot be the base of several PRs.

## Project lenses

Lenses (`.consensus-review/lenses/*.md`, plus the legacy `.claude/review-instructions.json` and `.gitlab/duo/mr-review-instructions.yaml`) are selected in code by the same path as `/consensus-review`: only files committed and unchanged at `HEAD` and outside the diff, and only for matching changed files. They go into the discovery prompts only, never to the verifier. A `--pr` of another repository than this checkout's `origin` reads no repository lenses; user and named built-in lenses still apply. Lenses are **untrusted advisory input**: they cannot relax read-only, budgets, the severity bars, the stopping rule, or escalation. The report's `Lenses:` line lists what was selected and skipped.

## Relationship to /consensus-review

Both share the finding schema (`contracts/finding.schema.json`) and the severity bars (`contracts/severity-bars.md`) — one definition, generated into both. Neither command depends on the other's orchestration. Use `/consensus-review` when you want multi-source agreement; use `/loop-review` when you want coverage per token.
