# /loop-review

The sequential strategy: build the review context once, then review it
in several differentiated passes. Back to the [README](../README.md).

```text
/loop-review [--pr=<n|url>] [--range=<base..head>] [--model=<m>] [--timeout=<sec>]
             [--max-tokens=<n>] [--max-calls=<n>] [--max-ms=<n>]
             [--out=<path>|--no-file] [--json]
```

Needs Node 20 or newer and the `claude` CLI. It does not use `codex`.

## Why passes, and why they are kept apart

Review models hyperfocus. They lock onto one theme and miss what sits
beside it. A second pass that reads the first pass's reasoning is
persuaded by it and restates the same theme.

So each later pass gets short fingerprints of what has been claimed,
what was refuted and which risk cells are still open, and **never** the
previous pass's reasoning. Leaving the reasoning out is the mechanism,
not an omission.

## Flags

| Flag                                       | Meaning                                                          |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `--pr=<n\|url>`                            | review a pull request                                            |
| `--range=<base..head>`                     | review a git range                                               |
| _(neither)_                                | review uncommitted changes against `HEAD`                        |
| `--model=<m>`                              | model for every pass, default `sonnet`                           |
| `--timeout=<sec>`                          | wall clock per pass, default `240`                               |
| `--max-tokens`, `--max-calls`, `--max-ms`  | hard budgets, unlimited by default (`0`); running out of one rules out `CLEAN` |
| `--out=<path>`                             | report destination, default `.reviews/loop-review-<hash>.md`     |
| `--no-file`                                | terminal only, nothing written                                   |
| `--json`                                   | print the whole run state as JSON instead of the report          |

## Results

A run ends in exactly one state:

- **`CLEAN`**: no confirmed findings, and everything below held.
- **`FINDINGS`**: confirmed findings, listed by severity.
- **`INCONCLUSIVE`**: coverage could not be established. This is not a
  clean result; the report lists the reasons.
- **`ESCALATE`**: a person is needed: a runner failure, missing context
  on a mandatory cell, an actionable finding verification never
  resolved, or the pass limit was hit with work left. Exits with code `2`.

`CLEAN` needs all of these at once:

- the minimum number of passes completed;
- no pass failed or was cut off;
- every cell covered **with evidence**, and every mandatory (high-risk)
  cell also verified independently;
- every actionable finding judged;
- the budget intact;
- the diff unchanged from start to end;
- a last pass that found nothing new.

A failed, truncated, stale or under-covered run cannot report `CLEAN`.
This is checked in code, which is why `/loop-review` is a runtime and
not a prompt: a prompt can be asked to hold that rule, but not made to.

## Passes and cells

The number of passes is fixed, not a flag:

- docs, generated files, formatting only: 0 or 1 light pass;
- any other code change: **at least 2**;
- auth, permissions, migrations, destructive data changes, public
  contracts, cross-service changes: **at least 3**;
- **4** at most. A run that reaches 4 with cells still uncovered, or
  whose last pass still found something new, escalates.

A **cell** is one changed surface times one risk category, derived from
the changed paths. For each cell a pass must return an evidence record:
the lines it actually inspected and the checks it actually ran. A cell
marked covered with no evidence is rejected. Sending a pass to look at
something is not coverage.

## It reports, it never repairs

`/loop-review` does not edit code, stage, commit, push or comment on a
pull request. This is enforced, not requested:

- each pass runs as its own `claude -p` process with `Edit`, `Write`,
  `NotebookEdit`, `TodoWrite`, `Bash`, `Task`, `Read`, `Grep`, `Glob`,
  `WebFetch` and `WebSearch` disallowed, and with every MCP server removed, so the
  model sees only the context it was given and has no tool that could
  change anything;
- the runtime runs no `git` or `gh` command that writes; `gh pr diff` is
  its only call to the forge (when `gh` fails on a PR URL, it fetches
  `<url>.diff` with `curl` into the temp directory instead);
- its only write is the report. Working files stay in a temp directory
  outside the repository.

The intended cycle: review, then a person or another agent applies the
fixes, then review the new diff. Each run hashes the diff, so a review of
old code cannot pass for a review of the current one.

## Custom instructions

If the repository has `.claude/review-instructions.json` or
`.gitlab/duo/mr-review-instructions.yaml`, the entries whose globs match
a changed file are added for that file (positive globs first, then `!`
exclusions). Rules for code the diff does not touch never enter the
context.

They are treated as untrusted advice: they cannot relax read-only mode,
the budgets, the severity bars, when the review may stop, or escalation.

## Cost

Measured: about **$0.28** for a small clean diff (2 passes) and
**$0.70 to $1.00** with findings (3 passes plus verification), on the
default `sonnet`. These are `total_cost_usd` as the CLI reports it: a bill on an
API plan, usage against your limit on a subscription.

Cost grows with the number of passes. The diff and its context are
cached across passes, but most of each call is Claude Code's own
preamble (its system prompt and tool schemas), which is paid again on
every pass. Details: [design/loop-review-measurements.md](design/loop-review-measurements.md).

## Output for scripts

`--json` prints the terminal state and its reasons, every finding with
its verdict, every cell with its evidence and verification, each pass
with its state, model and token usage, and the totals. Nothing is logged
to a file; redirect stdout if you want to keep it.
