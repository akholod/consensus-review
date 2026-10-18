# Troubleshooting

Start with the doctor. Back to the [README](../README.md).

```text
/consensus-review:doctor            in Claude Code, from the repository you review
/consensus-review:doctor offline    the same without the two live model calls
```

Plain `/doctor` is Claude Code's own command, not this one. Add `json` for
machine-readable output, or `repo=<path>` to check another repository.

**Why it exists.** This review degrades silently, on purpose. A missing
consultant does not stop a run; the review carries on with fewer
sources. That is right at run time, since a partial review beats none,
but it means a broken setup produces a report that looks complete and is
quietly weaker. The doctor tells you before you rely on one.

Each line is `PASS`, `WARN`, `FAIL` or `SKIP`. `FAIL` means a review
cannot run, or runs on something broken that looks fine. `WARN` means
fewer sources or a slower path. The exit code is `1` only when something
is `FAIL`.

## consultants

- **`codex — not installed`** (`WARN`): every review is Claude-only. The
  report says so in its Sources line and nothing else stops it. Install
  codex and run `codex login`; see [install.md](install.md).
- **`codex schema` fails** (`FAIL`, live): codex is installed but cannot
  review. Usually expired auth (`codex login` again) or a codex version
  that rejects the findings schema. Until it is fixed, the codex lane is
  reported `failed` and its findings are lost. That is a config bug, not
  a clean review.
- **`gh — not installed` or `not authenticated`** (`WARN`): pull
  requests are fetched by URL instead. Public repos work; private ones
  need `GITHUB_TOKEN`. Run `gh auth login`.
- **`pi — not installed`** (`SKIP`): only matters with `extra-advisor`.

## code graph

- **`codegraph CLI — not installed`** or **`graph in repo — none found`**
  (`WARN`): reviewers trace consumers with grep. That works, but the
  blast radius is slower to find and less precise. Install codegraph and
  run `codegraph init` in the repository.
- **`graph freshness — N day(s) older than the last commit`** (`WARN`):
  a stale graph can point reviewers at code that has moved, and they
  cannot tell from inside a review. Rebuild the graph.

## contracts

- **`agents and prompts`** (`FAIL`): an agent cannot be dispatched, or
  lost its read-only guarantee. The plugin files are damaged or edited.
  Reinstall with `claude plugin update consensus-review@crv`.
- **`generated blocks — out of sync`** (`FAIL`): a prompt asks for a
  shape the runtime does not parse. Same fix. In a clone, run
  `node scripts/gen-contracts.mjs`.
- **`dimension models`** (always `PASS`) lists each agent's model and
  effort; see [models.md](models.md).

## workspace

- **`not a git work tree`** or **`no commits yet`** (`FAIL`): there is
  nothing to diff. Run the review from inside a repository with at least
  one commit.
- **`.reviews in git — not ignored`** (`WARN`): the next review picks up
  this review's report as an untracked change. Add `.reviews/` to
  `.gitignore`.
- **`report output — directory is not writable`** (`WARN`): use
  `no-file`, or `out=<path>` somewhere writable.

## plugin and live

- **`version — installed X, latest Y`** (`WARN`): you are reviewing with
  older prompts than the released ones. Run
  `claude plugin update consensus-review@crv`.
- **`version — could not reach the release list`** (`WARN`): the check
  uses `gh`; it is missing, not logged in, or offline. Under `offline`
  the check is `SKIP`.
- **`node`** (`FAIL`): `/loop-review` needs Node 20 or newer.
- **`claude envelope`** (`FAIL`, live): `/loop-review` cannot read what
  the `claude` CLI returns, so every pass would fail. Check that
  `claude -p "hi"` works in a shell; if it does, the CLI's output format
  has changed and the plugin needs an update, so please open an issue
  with the doctor's output.
- **`SKIP — --offline`**: stale auth and format changes are not checked.
  Run without `offline` before trusting a setup you have not used for a
  while.

## A review looks too quiet

Read the report's `Sources` line before reading its findings:

- `codex=timeout`: the consultant ran out of time and its findings are
  lost. Raise `timeout=` (default `900`, up to `1800`) rather than
  lowering it.
- `codex=failed: <reason>`: the reason is codex's own error. Run the
  doctor.
- `codex=unavailable`: codex is not installed.
- A review with no P0 or P1 has no sceptic section. That is expected:
  the sceptic only runs when there is something to refute.

`/loop-review` ending in `INCONCLUSIVE` or `ESCALATE` is not a failure
of the review. It is the runtime refusing to call a run `CLEAN` that did
not earn it; the report lists why.
