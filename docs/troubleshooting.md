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
  reported `failed: <reason>` (not retried) and its findings are lost.
  That is a config bug, not a clean review.
- **`gh — not installed` or `not authenticated`** (`WARN`): pull
  requests come from a local clone, or by URL for a public repository. A
  private PR needs `gh` or a clone. Run `gh auth login`.
- **`pi — not installed`** (`SKIP`): matters when pi is the fallback
  consultant or with `extra=pi`.
- **pi does not see a model you use elsewhere**: pi runs without
  extensions, skills, context files or a saved session
  (`--no-extensions --no-session …`), and the catalog is read with
  `pi --no-extensions --list-models`. A provider that only an extension
  supplies (such as `claude-bridge`) is not available, so
  `pi-model=<that model>` fails in read-only mode. Pick a built-in
  provider's model.
- **Which consultant ran, and why?** Read the report header,
  `consultant: <name> (<reason>)`, and the doctor's consultant lines.
  Selection is by presence only: an installed but unauthenticated `pi`
  beats a working `claude`, and a model listed by `pi --list-models` is
  not necessarily one you are logged in to. To get another consultant,
  force it with `consultant=codex|pi|claude-cli`.
  A forced consultant that is not installed is reported `unavailable`
  and is not replaced. `node scripts/doctor.mjs --consultant <x>` checks
  the same forced choice (for `claude-cli` it runs the read-only probe).
  opencode is not supported yet.
- **`claude-cli` found nothing**: with `--json-schema` a refusal comes
  back as empty findings, so an empty result is weak evidence. Admin
  policy settings still apply under `--safe-mode`.

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
  this review's report as an untracked change, and the run archive is
  skipped. Add `.reviews/` to `.gitignore`.
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

## A result looks wrong

Open the run archive, `.reviews/<run-id>/`; the report's `Archive:` line
names it. See [consensus-review.md](consensus-review.md#the-run-archive)
for what it holds.

1. Open `meta.json`: the `missing`, `unavailable`, `notWritten` lists and
   each lane's model (CLI versions are not recorded; the attempt logs
   show what each CLI printed).
2. Open `events.jsonl`: what happened, in time order, per source.
3. Open that source's `sources/<name>/` output or attempt log: what the
   model was given and what it said. A refusal comes back as prose.

No archive means one of: `no-file`; `archive=off` (`--no-archive` for `/loop-review`); the
run was not in a git worktree; `.reviews/` is not ignored by git (the
doctor warns) or is a symlink; the diff is larger than 20 MiB; or a copy
or write failed. The report's `Archive:` line gives the reason.

To salvage a review that died before writing its archive, run from the
repository: `node scripts/archive-run.mjs finish --wd <work dir>`, with
the work dir printed at the start of the run. Without `--report`, the
run-id is `salvage-…`.

## A review looks too quiet

Read the report's `Sources` line before reading its findings:

- `codex=ok (retried: <why>)`: the first attempt failed and the retry
  answered. Nothing is lost; a recurring `timeout` here means `timeout=`
  is close to the limit.
- `codex=degraded (<why>; <why>)`: both attempts failed (or the second
  had no time left in the 2×T budget per phase), so its findings are
  lost. For `timeout`, raise `timeout=` (default `900`, up to `1800`)
  rather than lowering it; otherwise read the attempts under *Source
  availability*.
- `codex=failed: <reason>`: a config error, not retried. The reason is
  codex's own error. Run the doctor.
- `failed: helper error (<reason>)`: the lane helper was killed or
  crashed and left no status. Rerun the review.
- A `Single-source review (Claude only)` warning under the title: no
  consultant produced a usable review.
- `codex=unavailable`: codex is not installed (or forced and missing).
- `EVIDENCE → CONCERN (cannot verify outside diff)` under *Dropped /
  Downgraded (sceptic)*: a refutation quoted a file the check could not
  read, so it counted as a doubt and did not remove the finding. In PR
  mode, fetch the PR's head commit into the local clone.
- A review with no P0 or P1 has no sceptic section. That is expected:
  the sceptic only runs when there is something to refute.

`/loop-review` ending in `INCONCLUSIVE` or `ESCALATE` is not a failure
of the review. It is the runtime refusing to call a run `CLEAN` that did
not earn it; the report lists why.
