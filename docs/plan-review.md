# /consensus-review:plan-review

Review of one plan, spec or design doc before any code exists. An Opus
arbiter merges the `plan-reviewer` agent and one consultant (codex, else
pi, else claude-cli; `extra=pi` adds pi). Read-only: the document and the
code are never edited.

```
/consensus-review:plan-review docs/plan.md
/consensus-review:plan-review ~/notes/design.md sceptic=strict lang=ru
```

## Settings

Applied, as in [/consensus-review](consensus-review.md): `sceptic`,
`consultant`, `extra`, `pi-model`, `timeout`, `out`, `archive`, `lang`,
`models`, `effort`, `profile`. The `models`/`effort` role for the agent is
`plan` (see [Models](models.md)).

`sceptic` defaults to `basic` (the verifier alone); `sceptic=strict` adds
the consultant refuters.

Ignored, and listed in the report as `<key>=<value> (not used by
plan-review)`: `depth`, `deep`, `minimal`, `dims`, `lenses`, `base`.

## Dimensions

Every run reviews five, with no triage tiers:

- `feasibility`: every file, symbol, flag and API the document names exists and behaves as assumed.
- `completeness`: missing cases, failure modes, boundaries, rollback.
- `ambiguity`: contradictions, terms with two meanings, steps read two ways.
- `scope`: creep or gaps against the goal; complexity out of proportion.
- `testability`: checkable acceptance criteria, stated expected values, an observable and reversible rollout.
  A behavioural criterion needs a literal expected value with its source, numeric boundaries with inclusivity, and the cheapest test level that observes the failure; *valid* or *fast* with no number is not checkable.

## Severity

P0 and P1 need a consequence: a `failure_scenario` saying what breaks or
gets built wrong if the plan ships as written. A candidate without one is
not graded; it becomes a question under **Open questions for the author**
(the agent's own questions plus these, no cap, not counted in Totals,
never sent to the sceptic). A P2 needs a concrete cost and an anchor in
the document or the repository.

## Input

One path, UTF-8 text, 1 to 131072 bytes (128 KiB). The path may not
contain `=` or spaces. A PR or URL is rejected.

## Outside a git repository

Doc-only mode: feasibility is not checked (the report says `feasibility:
not checked (no repository)`), the run archive is not written, and lanes
run in `$WD/doc-cwd`, an empty directory holding a copy of the document.

## Report

`.reviews/plan-review-<slug>-<date>.md`, or `-2`, `-3`… when that name is
taken, so an earlier report is never overwritten. `out=<file|dir>` and
`out=none` work as in `/consensus-review`.

## What is sent

As for a diff: the document goes to the consultants, which also get read
access to the repository (or to `doc-cwd` outside one). See
[What it runs and sends](https://github.com/akholod/consensus-review/blob/main/README.md#what-it-runs-and-sends).

## Accepted residual risks

- `doc-cwd` is not a read boundary; codex, pi and claude-cli can read outside it.
- One Claude lane: lower recall than the four-agent panel.
- A run that fails after the report name is reserved leaves an empty placeholder in `.reviews/`; the next run takes the next suffix.
- Paths with `=` or spaces are unsupported.
