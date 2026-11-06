# /consensus-review

The parallel strategy: several independent reviewers look at the same
change, an arbiter merges what they found, and a sceptic tries to refute
every serious finding. Back to the [README](../README.md).

```text
/consensus-review [<PR-url|owner/repo#N|#N>] [deep|minimal] [dims=<list>] [sceptic=off|basic|strict]
                  [lang=<language>] [no-file] [profile=<name>] [<key>=<value>…]
```

`<PR>` is a PR URL (it may end in `/files`, `?diff=split` or `#…`), `owner/repo#N` or
`#N`. Without it, the review covers your uncommitted changes (staged,
unstaged and untracked). Two targets: the last one wins. A token that
looks like a target but is not one (any other URL, a `/pull/` path, or
`…#N` with other characters) stops the run:
`<token>: not a valid PR target (letters, digits and ._-/#=? only)`.

## Arguments

The arguments are `key=value` pairs, plus a target and three shorthands.
A resolver script (`scripts/settings.mjs`) parses them before the review
starts and prints them in the report as one `Settings:` line, each value
with its source (`flag`, `profile <name>` or `default`).

**Rules**

- No value can contain whitespace: `lang=pt-BR`, not `lang="pt BR"`.
- Keys and fixed values are case-insensitive; `lang`, `out` and `pi-model` keep their case.
- A key given twice: the last one wins, and the earlier one is listed in `Ignored args`.
- An unknown token is ignored but listed in the report header as
  `Ignored args`, so a typo never passes for a default.
- A known key with a bad value stops the run before anything is spent. The
  message lists the valid values, for example
  `sceptic=strct: expected off|basic|strict`.
- A `--` prefix is accepted on every argument (`--deep`, `--lang=uk`).
- Three shorthands: `deep` is `depth=deep`, `minimal` is `depth=minimal`,
  `no-file` is `out=none`.

### Everyday

| Argument                  | Effect                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `<PR>`                    | the PR to review; default: your uncommitted changes. A malformed PR URL or `owner/repo#N` stops the run, never falls back                    |
| `depth=<mode>`            | `auto` (default), `minimal` or `deep`; shorthands `deep` and `minimal`. `deep` skips triage and runs the full panel; `minimal` forces the smallest tier with a shallow exploration budget; the last one wins |
| `dims=<list>`             | set the lanes from `architecture,quality,impact,tests`: `dims=impact,quality` replaces the tier's set, `dims=+architecture,-quality` adjusts it. Do not mix both forms. `dims=+tests` is the only way to review tests when the diff has no test files |
| `sceptic=strict`          | the default: an independent verifier plus the consultants re-run as refuters; typed votes per finding (see The sceptic)                      |
| `sceptic=basic`           | the verifier alone, the same vote rules with one voter                                                                                       |
| `sceptic=off`             | no sceptic pass                                                                                                                              |
| `lang=<language>`         | report language, default `en`: a code or a name (`uk`, `pt-BR`, `Українська`); code, paths and terms stay as they are                        |
| `no-file`                 | terminal only; the run writes nothing to disk, the archive included                                                                          |
| `profile=<name>`          | apply the repository profile `.consensus-review/profiles/<name>.md` (see [Profiles](#profiles)); flags still win. A profile the run cannot apply stops it |

### Advanced

| Argument                  | Effect                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `out=<path>`              | write the report to a directory or an exact file; `out=none` is `no-file`. The path takes only letters, digits and `._/~+@,-`                  |
| `archive=on\|off`         | default `on`; `off` writes no run archive (see [The run archive](#the-run-archive))                                                          |
| `consultant=<name>`       | `auto` (the default), `codex`, `pi` or `claude-cli`. A forced consultant that is missing is `unavailable`, never replaced                    |
| `extra=pi`                | add `pi` as a second consultant; default `off`                                                                                               |
| `pi-model=<model>`        | pin pi's model (default `auto`), for example `pi-model=sonnet:high`; overrides the automatic choice. When no pi lane can run (`consultant=codex` or `claude-cli` with `extra=off`), it is listed in `Ignored args` |
| `timeout=<sec>`           | wall clock per attempt, an integer, default `900`, clamped to `[30, 1800]`; retried once, at most 2×T per phase                              |
| `models=<role:model,…>`   | request a model per role (default `agent`: each agent's frontmatter model). Roles `architecture`, `impact`, `quality`, `tests`, `verifier`; models `opus`, `sonnet`, `haiku`, `fable`; no spaces, e.g. `models=verifier:fable,tests:haiku`. Unlisted roles keep their frontmatter model. See [Models and effort](#models-and-effort) |
| `effort=<role:effort,…>`  | request an effort per role (default `agent`: each agent's frontmatter effort). The same roles; efforts `low`, `medium`, `high`, `xhigh`, `max`, e.g. `effort=verifier:high,impact:high` |
| `base=<branch>`           | the branch the PR targets. Needed only for a PR diffed from a local clone without `gh`, which stops without it; see [Pull requests without `gh`](#pull-requests-without-gh). Not a profile key; without a PR target it is listed in `Ignored args` |

P2 findings are always grouped: up to 7 are listed and the rest are rolled
up by theme. The run archive holds every P2.

### Models and effort

`models=` and `effort=` (a flag or a profile key) override the model and
the effort of the listed roles only; a flag replaces a profile's map
whole. The `Settings:` line shows the canonical map in role order,
marked `requested`: `models=impact:fable,verifier:fable (flag, requested)`.

- The arbiter is the session model (`/model`); no setting changes it.
- The values are requests. Claude Code may reject a model or effort (for
  example `fable` where it is not available) or substitute another model.
  A Task rejected for its override is re-run once without its overrides,
  and Source availability says `models override dropped (<role>)` or
  `effort override dropped (<role>)`; only when that retry also fails is
  the lane reported failed or degraded, as for any other failure.
- Per-invocation `effort` on subagents needs Claude Code 2.1.292 or later;
  an older CLI may ignore it (`/consensus-review:doctor` warns).
- A weaker verifier (`models=verifier:haiku`) lets false findings through;
  that is why its frontmatter keeps it on Opus.

The frontmatter defaults and their rationale are in [models.md](models.md).

Depth (`deep`, `minimal`) and lanes (`dims`) are independent:
`minimal dims=+architecture` is a shallow pass that includes architecture.

**Do not set `timeout` low to save time.** A consultant that times out
or fails transiently is retried once; if the retry fails too, it is
reported `degraded` and its findings are lost: the cost is a whole
source missing, not a slower review. A config error (bad auth, a
rejected schema, an unknown model) is not retried. Each phase is
bounded by 2×T: the review, and in `strict` mode the refuter re-runs
separately, so a strict review can take up to about 4×T. Consultants
run in parallel, so a high ceiling costs nothing until one hangs. A
codex review of a small repository has been measured still working at
600 seconds.

## How a review runs

1. **Resolve the diff.** A PR comes from `gh pr diff`, or without `gh`
   from a local clone or a public diff URL (see [Pull requests without
   `gh`](#pull-requests-without-gh)); local changes from `git diff HEAD` plus untracked
   files. Everything is copied to a temp directory outside the repository.
2. **Triage.** The change gets a tier from its *effective size* (docs,
   lock files, fixtures, assets, generated code, i18n and HTTP
   collections such as `.bru` do not count; config such as JSON, YAML,
   Dockerfiles, CI and Terraform does) and its *blast radius* (shared modules, contracts,
   manifests, migrations, auth, fan-in; fan-in comes from `codegraph`
   when it is installed).
3. **Review.** The tier's Claude agents run read-only. The consultant
   (see below) and `pi` with `extra=pi` review the same change independently from a
   short brief that does not lead them. The agents and codex may use a
   code graph; pi runs with a read-only toolset and no shell
   (`read,grep,find,ls`, with `--no-mcp` so no MCP server tools are
   loaded), so it navigates by reading and grepping. It also runs
   without extensions, skills, prompt templates, context files or a
   saved session (`--no-extensions --no-session --no-skills
   --no-prompt-templates --no-context-files --no-approve`).
4. **Merge.** The arbiter deduplicates, tags each finding with its
   dimension and who found it (`[claude|codex|pi]`), and sets the final
   severity.
5. **Sceptic.** Fires only when there are P0 or P1 findings, so a clean
   review pays nothing for it.
6. **Report.** Terminal plus `.reviews/review-<slug>-<date>.md`, and the [run archive](#the-run-archive).

### Pull requests without `gh`

When `gh` is missing or not signed in, `scripts/pr-diff.mjs` resolves
the PR, in this order:

1. **A local clone.** The remote whose configured URL names the PR's
   repository (`#N` means `origin`). The raw `remote.<name>.url` is
   compared, not the `insteadOf`-rewritten one. This path needs
   `base=<branch>`, the branch the PR targets: guessing it from the
   default branch would make a backport whose head is already in `main`
   review as an empty diff. It also needs full history; a shallow clone
   stops. It reads the SHAs of `refs/pull/<N>/head` and
   `refs/heads/<base>` with `git ls-remote`, fetches them with no
   destination (`--refmap= --no-write-fetch-head --no-tags`), then
   reads the SHAs again; a ref that moved stops the run. The diff is
   `git diff -M <merge-base> <head>`, by SHA, so a stale local `<base>`
   branch does not change it. The fetch adds objects to your clone and
   nothing else: no ref, no `FETCH_HEAD`, no config. It never checks
   the PR out.
2. **A public diff URL**, for a PR URL or `owner/repo#N` with no
   matching remote: `curl` on `https://<host>/<owner>/<repo>/pull/<N>.diff`,
   where the host is the URL's, or origin's for `owner/repo#N`. This is
   diff-only mode. No token is read from your environment.

Anything else stops the run. `/loop-review` takes the same path, with
`--base=<branch>`.

### Tiers

| Tier   | When                                                                                              | Claude agents                             | Consultants |
| ------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------- |
| **T0** | only non-code changed                                                                             | none, short report                        | none        |
| **T1** | small and isolated                                                                                | impact                                    | codex       |
| **T2** | small or medium and local; medium and isolated; small but wide, with no high-risk path            | impact, quality, tests if the diff has any | codex       |
| **T3** | large; structural; wide at medium size or more; **any size touching a high-risk path**            | the above plus architecture               | codex       |

Blast radius decides which lane you cannot skip; size decides how many
lanes are worth paying for. A 20-line change to a shared module needs
its consumers traced, not an architecture verdict. High-risk paths are
the exception: migrations, auth and permissions, security code and
dependency manifests go to T3 at any size, because how badly they fail
does not depend on how many lines changed.

*Isolated* also covers an edit confined to one file whose changed
symbols have no consumers outside it, so a small local edit can reach T1
instead of piling up at T2.

`extra=pi` adds `pi` at every tier above T0.

### The consultant

The consultant is the first installed of `codex` → `pi` → `claude-cli`;
`consultant=` overrides it. The report header says which ran and why
(`consultant: <name> (<reason>)`). opencode is not supported yet.

- **pi's model depends on its role.** Claude models are never picked
  automatically, and pi's own default is never used unpinned.
  - As the consultant: an OpenAI model first, then glm, qwen, kimi via
    `opencode-go`.
  - As the extra: glm, qwen, kimi.
  - `pi-model=<model>` overrides the choice. See
    [models.md](models.md#how-pi-picks-its-model). pi runs without
    extensions, so a model whose provider only an extension supplies
    (such as `claude-bridge`) is not available in read-only mode.
- **claude-cli** is a separate `claude -p` process run with
  `--safe-mode --restricted --tools Read,Grep,Glob`, no MCP servers and
  no session persistence; the doctor proves it cannot write. It gives
  *context* independence only, not model independence, so it counts as
  the same source as the Claude panel. It uses your Claude quota. Under
  `--json-schema` a refusal comes back as empty findings, so an empty
  claude-cli result is weak evidence, not a clean bill. Admin-managed
  policy settings still apply under `--safe-mode`.

**Cost** follows the tier, so triage does most of the saving. `minimal`
forces the floor; `deep` and `extra=pi` raise it. Strict sceptic
adds one refuter run per voting consultant family (the consultant's,
plus the extra's when it is another family; none for claude-cli, which
is the panel's family), and only on reviews that found a P0 or P1.

### Severity, and the two bars

- **P0**: blocker. Wrong behaviour, security, data loss, crash, a
  breaking change.
- **P1**: important, not a blocker.
- **P2**: minor.

Every lane applies the same two bars, in the agents and in the
consultant brief alike:

- **Evidence bar.** A P0 or P1 needs a concrete failure scenario: which
  input or state leads to which wrong result. Without one it goes to
  *Unverified*, not down to P2.
- **Admission bar.** A P2 must name what leaving it costs **and** a
  project-specific anchor: a documented convention, an existing pattern,
  a contract. A general best practice alone is not a finding.

Without both bars, P2 becomes the place where unproven claims go to
survive, and the report fills with twenty entries of noise.

A lane may report something outside its own dimension and tag the lane
that owns it with `owner:`. If that lane did not run (architecture is
absent at T2, for example), the finding keeps its severity and is marked
*ungraded*. A finding is never lost because its lane was skipped.

### The sceptic

The verifier is a separate agent with a fresh context. It is not one of
the reviewers and not the arbiter, so it has no findings of its own to
defend. It tries to refute each P0 and P1 with evidence.

In `strict` mode the consultants also re-run as refuters and vote
with the verifier. In `basic` mode the verifier votes alone, under the
same rules. Each vote is one of:

- `AGREE`: the finding holds, with the harm path at `file:line`;
- `DISAGREE_EVIDENCE`: a contiguous verbatim quote of the reviewed code,
  with its `file:line`, that shows the finding is wrong;
- `DISAGREE_CONCERN`: a doubt without such a quote.

A `DISAGREE_EVIDENCE` whose quote cannot be found near the cited line
counts as a concern, and the report logs why (`cannot verify outside
diff`, `elided quote`, …). The check proves only that the quote exists
there, not that it is relevant. It reads the diff, and outside the diff
only the local clone at the PR's head commit. In PR mode, a head commit
missing from the local clone turns every quote outside the diff into a
concern.

Per finding, with `A` the `AGREE` votes, `E` the verified
`DISAGREE_EVIDENCE` votes and `cast` every vote (concerns included),
the rules apply in order:

1. no verifier vote: `unconfirmed`;
2. `E > A`, and the verifier voted a verified `DISAGREE_EVIDENCE` or
   `2·E > cast`: `refuted`;
3. `A > E`, and the verifier voted `AGREE` or `2·A > cast`:
   `confirmed`, with the concerns shown next to it;
4. otherwise: `unconfirmed`.

| Votes (V = verifier, R = refuter) | Decision |
|---|---|
| V AGREE, every other vote a concern | confirmed |
| V EVIDENCE, every other vote a concern | refuted |
| AGREE and EVIDENCE tied | unconfirmed |
| V CONCERN and one R AGREE or EVIDENCE | unconfirmed |
| V CONCERN and two R AGREE / two R EVIDENCE | confirmed / refuted |
| V AGREE and two R EVIDENCE | refuted |
| no verifier vote, or only concerns | unconfirmed |

So doubt never removes a finding the verifier grounded, and a lone
refuter can neither confirm nor refute. Add `extra=pi` for a third
voter. If the decision step fails, the verifier's `AGREE` confirms and
everything else is `unconfirmed`; nothing is refuted without a checked
quote.

At most one refuter votes per model family. A consultant of the
panel's family (claude-cli, or pi on a Claude model), a second lane of
a family that already votes, and any `unknown` family get no refuter.
Changed in this release: codex plus pi on an OpenAI model now runs one
refuter, not two. If no refuter is independent, the vote is
`strict → basic (no independent refuter)`.

Findings that do not survive move to the *Unconfirmed* or *Unverified*
sections of the report. A P0 is never dropped silently, and every drop
is logged.

## The report

- a header with the tier, the `Settings:` line, sources and their status
  and any `Ignored args`. Each consultant, refuters included, shows one
  status:
  - `ok`: it answered first time;
  - `ok (retried: <why>)`: the first attempt failed, the retry answered;
  - `degraded (<why>; <why>)`: both attempts failed, or
    `degraded (<why>; no time left)` when the 2×T budget left no room
    for a retry. Its findings are lost;
  - `failed: <reason>`: a config error, not retried;
  - `failed: helper error (<reason>)`: the lane helper itself died or
    left no status. Treated as a failure, never as zero findings;
  - `unavailable` or `skipped (<why>)`;
- findings by severity, each with location, failure scenario, agreement
  badge and confidence;
- a summary per dimension;
- the *Unconfirmed*, *Unverified* and *Dropped* sections.

`Totals` always counts every finding, whatever the P2 grouping rolls up.

**Read the Sources line.** A consultant that is missing or fails does not
stop the review; the review carries on with fewer sources. The report
says so in that line, in *Source availability* (every attempt and its
reason, the vote mode and how many voters each finding had), and, when
no consultant produced a usable review, in a *Single-source review*
warning under the title. `/consensus-review:doctor`
finds these problems before you rely on a review.

## The run archive

Unless `no-file` (`out=none`) or `archive=off` is given, the run also leaves a
private copy of what it saw in `.reviews/<run-id>/`, so a strange result
can be traced. The run-id is the report's name plus a UTC timestamp. It
holds:

- `diff.patch`, the diff reviewed, never truncated;
- the prompt each consultant and refuter got, and its attempt logs
  (consultant transcripts, which can include any repo file a model read);
- findings per stage (`findings/`) and the arbiter's decisions;
- `events.jsonl`, the run's events in time order;
- `meta.json`: `schema`, `runId`, `createdAt`, `command`, `target`,
  `mode`, `pluginVersion`, `report`, `workDir`, `flags`, `diffHash`,
  `lanes` (each consultant's status, display, model, provider and
  schema), `missing` (expected work files that were absent), `transcribed`
  (files written by the arbiter, not captured verbatim), `unavailable`
  (sources the plugin cannot capture), `notWritten` (archive files
  withheld, with the reason) and `truncated` (files cut or dropped by the
  caps).

The archive goes only to the invoking repository's `.reviews/`, and only
when git ignores that path, never next to an external `out=`. Directories
are `0700` and files `0600`. A file over 2 MiB keeps its head and tail (a
truncated `.json` is no longer valid JSON), and an archive stops at
20 MiB. An archive that cannot be written never fails the review; the
report says `Archive: not written (<reason>)`.

The raw prompts and transcripts of the Claude Task agents are not
available to the plugin, so they are listed under `unavailable`. There is
no retention: remove old runs with `rm -rf .reviews/<run-id>`.

## The single-dimension commands

`/impact-review`, `/quality-review`, `/test-review` and `/arch-review`
run one agent, with the same severity bars and no consultant, arbiter or
sceptic. They take a scope (empty for the working tree, a PR, a range
such as `main..HEAD`, or a path) and `lang=`.

`/architecture-audit` is different: it reviews the whole project's
architecture, not a diff, and is heavier.

## Project lenses

A lens is a project rule the reviewers apply to the files it names. Lenses
live in the repository, one Markdown file each:

```text
.consensus-review/lenses/payments.md
```

```markdown
---
paths:
  - "src/payments/**"
  - "!src/payments/fixtures/**"
dimension: impact
---
- Every charge path is idempotent: a retried request with the same key must not charge twice.
- Amounts are integer minor units; a float anywhere on the money path is a finding.
```

**Front matter.** Line 1 is `---`; the closing `---` is within the first
50 lines.

| Key | Meaning |
|---|---|
| `paths` | Required. `  - "<glob>"` lines or an inline `["a", "!b"]`. A `!` entry excludes. |
| `dimension` | Optional: `architecture`, `quality`, `impact` or `tests`. Absent means every lane in the run. |

Any other key is ignored (the doctor reports it). The body is the text
after the closing `---`. The name is the file stem, `[a-z0-9][a-z0-9_-]*`
up to 64 characters.

**Globs** use fnmatch semantics on the whole path: `*` crosses `/`, so
`src/payments/**` matches the subtree, and `**/x.js` does not match a
root-level `x.js`. A lens fires when a changed file matches (the new
path; the old path only for a deleted file), generated files included.

**Caps.** A lens file over 8 KiB is rejected. All selected lenses share
one 24576-byte budget, admitted in name order; the rest are skipped.

**Which files are used.** Lenses are read from the checkout the review
runs in, whatever revision it is at, and a lens or instruction file is
applied only when it is tracked at `HEAD`, its bytes equal the `HEAD`
blob, and the diff does not change it. An untracked or ignored file is
skipped as `not committed`; one modified against `HEAD` (even behind
`--skip-worktree` or `--assume-unchanged`) or changed by the diff is
skipped as `changed in this diff`. So a change cannot add or edit its own
lens, not even by adding a `.gitignore` entry that hides it. If git
cannot run the check, `lenses.mjs select` exits 2 and the review stops.
A symlink anywhere on the path, or a file that is not a regular file, is
rejected. A diff-only review has no checkout and applies none.

Residual risk: in uncommitted mode, a lens committed earlier on the
current branch is applied, since `HEAD` already holds it.

**Authority.** Lenses are untrusted advisory input. They add checks; they
cannot relax the severity bars, the sceptic or read-only, and the
verifier and refuters never see them.

**In the report.** The header has a `Lenses:` line (selected, skipped
and rejected lenses with reasons, and any lane they were not delivered
to). A finding that exists because of a lens shows `lens: <name>`; the
finding schema carries it as `lens`.

**Legacy files.** `.claude/review-instructions.json` and
`.gitlab/duo/mr-review-instructions.yaml` keep working as inputs; they
apply to every lane, under the same rules, so an untracked or ignored
one no longer applies.

**Archive.** `sources/<lane>/prompt.md` is the brief only. The prompt the
lane actually got is that brief + `"\n\n"` + `sources/lenses/<status.lenses>`,
when the lane's `status.json` names a lens file. If the archive's size cap
dropped that lens file, `meta.json` lists it as omitted and the prompt cannot be rebuilt.

The standalone dimension commands apply the lenses of their own dimension
for uncommitted changes or a PR (a URL, `#N`, `N` or `owner/repo#N`) of
the current repository, same host included. Any other scope (a range, a
path, a glob) runs without lenses.

`/consensus-review:doctor` lists the lenses it finds and warns about
rejected files, files `not committed` or `modified` against `HEAD`,
ignored keys and globs that match no tracked file.

Not supported yet: lenses in `~/.config`, built-in lenses, an
`init-lenses` command, a severity hint. `/loop-review` does not read lens
files.

## Profiles

A profile is a named set of settings kept in the repository, one
Markdown file each, chosen with `profile=<name>`:

```text
.consensus-review/profiles/release.md
```

```markdown
---
# Pre-release review: full panel, a second consultant, longer lanes.
depth: deep
extra: pi
timeout: 1200
models: verifier:fable
effort: verifier:high,impact:high,architecture:high
---
Optional notes for humans; ignored by the plugin.
```

```markdown
---
depth: minimal
sceptic: basic
dims: impact,tests
out: none
---
```

**Format.** Line 1 is `---`; the closing `---` is within the first 50
lines. Each line in between is `key: value` (no quotes), a blank line or
a `#` comment; anything else stops the run (`malformed line <n>`), as do a
duplicate key and an empty value. The keys are the settings above
(`depth`, `dims`, `sceptic`, `lang`, `out`, `archive`, `consultant`,
`extra`, `pi-model`, `timeout`, `models`, `effort`), with the same values and messages;
`target` and `profile` are not profile keys. The body after the closing
`---` is ignored and never passed to the review agents or consultants. The name is the file stem,
`[a-z0-9][a-z0-9_-]*` up to 64 characters, matched exactly; the file is
at most 4096 bytes.

**Precedence.** flag > profile > default. A flag replaces a profile's
value whole (`dims=-quality` replaces the profile's `dims`). One profile
per run; a second `profile=` wins and the first goes to `Ignored args`.
There is no implicit default profile.

**Visible.** Every value a profile sets shows `(profile <name>)` on the
`Settings:` line, for example `sceptic=off (profile ci)`. A profile may
weaken a review (fewer lanes, `sceptic=off`); it can change only what
flags can change, and the severity bars stay.

**Only a committed profile is applied.** The change under review must not
configure its own review, so the profile is applied in code once the
diff exists, and only when it is tracked by git, unchanged against
`HEAD` and not in the diff (as a path or a rename source). Anything else
stops the run with the file and the reason; it never falls back to the
defaults:

- a profile the diff touches, or one whose bytes differ from its `HEAD` blob (an index flag such as `skip-worktree` or `assume-unchanged` does not hide the edit): `changed in this diff`;
- an untracked profile, an ignored one included: `not tracked`;
- a symlink anywhere on the path, or a file that is not a regular file;
- a malformed file, a bad value, an unknown name (the message lists the available profiles);
- diff-only mode, which has no checkout to read a profile from;
- a git error during the check: `git check failed`.

To use an edited profile, commit it first, or pass its settings as flags.
In PR mode the profile is read from your local checkout and must match
its `HEAD`: a profile you edited locally stops the run, even when the PR
does not touch it.

`/consensus-review:doctor` lists the profiles with their keys and warns
about one that would stop a run.

### Writing profiles: `/consensus-review:profile`

`/consensus-review:profile` is the only command that writes, and it
writes only `.consensus-review/profiles/<name>.md`. It never commits.

```text
/consensus-review:profile quick depth=minimal dims=+quality sceptic=basic effort=verifier:medium,impact:medium
/consensus-review:profile release depth=deep extra=pi timeout=1200 models=verifier:fable effort=verifier:high,impact:high,architecture:high
```

The first creates `.consensus-review/profiles/quick.md`:

```markdown
---
depth: minimal
dims: +quality
sceptic: basic
effort: impact:medium,verifier:medium
---
```

`release` requests `fable` for the verifier, which the host may reject or
substitute (see [Models and effort](#models-and-effort)).

It ends with the commit to run, limited to that one file:

```text
Not applied until committed: git add -- .consensus-review/profiles/quick.md && git commit -m 'Add review profile quick' -- .consensus-review/profiles/quick.md
```

(`Update review profile <name>` when the file already existed.)

- Only `key=value` pairs, with the keys and values of `/consensus-review`; `deep`, `minimal` and `no-file` are refused (`deep: expected key=value`). `key=` removes the key.
- Every value is checked as a flag would be and stored in its canonical form (`sceptic=BASIC` → `basic`, `timeout=5000` → `1800`). The keys are rewritten in settings order; comments in the front matter are dropped (the output says so); the body is kept byte for byte.
- An existing file that does not parse is never overwritten: `profile <name>: <error>; fix or delete the file`. A symlink anywhere on the path stops it too.
- The file is replaced atomically and keeps its mode; a new file is created `0644`, less your umask.
- `/consensus-review:profile <name>` prints a profile; with no arguments it lists the built-in defaults on the first line, then each profile with its keys (an invalid one as `<name>: invalid (<error>)`). To delete a profile, use `git rm`.

The defaults are shown in two places: the `Settings:` line of a report
and the first line of the `/consensus-review:profile` listing. No default
profile file is ever created.

## Code graphs

Agents use a code graph when the repository has one
(`.codegraph/codegraph.db` or `graphify-out/graph.json`) and grep when it
does not. The plugin never builds one. A graph reflects its last build,
so agents use it for existing code and the diff itself for new symbols.
The doctor warns when the graph is older than the last commit.
