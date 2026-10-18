# /consensus-review

The parallel strategy: several independent reviewers look at the same
change, an arbiter merges what they found, and a sceptic tries to refute
every serious finding. Back to the [README](../README.md).

```text
/consensus-review [<PR>] [deep|minimal] [dims=<list>|arch] [sceptic=off|basic|strict]
                  [extra-advisor[=<model>]] [timeout=<sec>] [p2=grouped|full|off]
                  [out=<path>|no-file] [lang=<language>]
```

`<PR>` is a PR URL, `owner/repo#N` or `#N`. Without it, the review covers
your uncommitted changes (staged, unstaged and untracked).

## Flags

Every flag works with or without a leading `--`. An unknown flag is
ignored but listed in the report header as `Ignored args`, so a typo
never passes for a default.

| Flag                      | Effect                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `deep` (or `full`)        | skip triage, run the full panel; wins over `minimal`                                                                                         |
| `minimal`                 | the smallest tier, with a shallow exploration budget                                                                                         |
| `dims=<list>`             | set the lanes: `dims=impact,quality` replaces the tier's set, `dims=+tests,-quality` adjusts it; `dims=+tests` is the only way to review tests when the diff has no test files |
| `arch`                    | same as `dims=+architecture`                                                                                                                 |
| `sceptic=strict`          | the default: an independent verifier plus the consultants re-run as refuters, majority vote per finding                                      |
| `sceptic=basic`           | the verifier alone, no vote                                                                                                                  |
| `sceptic=off`             | no sceptic pass (`no-sceptic` is an alias)                                                                                                   |
| `extra-advisor[=<model>]` | add `pi` as a second consultant; `=<model>` picks its model, for example `extra-advisor=sonnet:high`                                         |
| `timeout=<sec>`           | wall clock per consultant, default `900`, clamped to `[30, 1800]`                                                                            |
| `p2=grouped`              | the default: up to 7 P2s listed, the rest rolled up by theme                                                                                 |
| `p2=full` / `p2=off`      | list every P2 / show only the count                                                                                                          |
| `out=<path>`              | write the report to a directory or an exact file                                                                                             |
| `no-file`                 | terminal only; the run writes nothing to disk                                                                                                |
| `lang=<language>`         | report language: any language, as a code or a name; code, paths and terms stay as they are                                                  |

Depth (`deep`, `minimal`) and lanes (`dims`, `arch`) are independent:
`minimal arch` is a shallow pass that includes architecture.

**Do not set `timeout` low to save time.** A consultant that hits it is
reported as `timeout` and its findings are lost: the cost is a whole
source missing, not a slower review. Consultants run in parallel, so a
high ceiling costs nothing until one hangs. A codex review of a small
repository has been measured still working at 600 seconds.

## How a review runs

1. **Resolve the diff.** A PR comes from `gh pr diff` (or a URL fetch
   without `gh`); local changes from `git diff HEAD` plus untracked
   files. Everything is copied to a temp directory outside the repository.
2. **Triage.** The change gets a tier from its *effective size* (docs,
   lock files, fixtures, assets, generated code, i18n and HTTP
   collections such as `.bru` do not count; config such as JSON, YAML,
   Dockerfiles, CI and Terraform does) and its *blast radius* (shared modules, contracts,
   manifests, migrations, auth, fan-in; fan-in comes from `codegraph`
   when it is installed).
3. **Review.** The tier's Claude agents run read-only. `codex` (and `pi`
   with `extra-advisor`) review the same change independently from a
   short brief that does not lead them. The agents and codex may use a
   code graph; pi runs with a read-only toolset and no shell
   (`read,grep,find,ls`), so it navigates by reading and grepping.
4. **Merge.** The arbiter deduplicates, tags each finding with its
   dimension and who found it (`[claude|codex|pi]`), and sets the final
   severity.
5. **Sceptic.** Fires only when there are P0 or P1 findings, so a clean
   review pays nothing for it.
6. **Report.** Terminal plus `.reviews/review-<slug>-<date>.md`.

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

`extra-advisor` adds `pi` at every tier above T0.

**Cost** follows the tier, so triage does most of the saving. `minimal`
forces the floor; `deep` and `extra-advisor` raise it. Strict sceptic
adds one codex run, and only on reviews that found a P0 or P1.

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

In `strict` mode the consultants also re-run as refuters and each
finding is put to a vote. A tie is not a confirmation: with the default
two voters (verifier and codex), a finding needs both to survive as
stated. Add `extra-advisor` for a third voter.

Findings that do not survive move to the *Unconfirmed* or *Unverified*
sections of the report. A P0 is never dropped silently, and every drop
is logged.

## The report

- a header with the tier, flags, sources and their status
  (`codex=ok|timeout|failed: <reason>|unavailable`), and any ignored
  flags;
- findings by severity, each with location, failure scenario, agreement
  badge and confidence;
- a summary per dimension;
- the *Unconfirmed*, *Unverified* and *Dropped* sections.

`Totals` always counts every finding, whatever `p2=` hides.

**Read the Sources line.** A consultant that is missing or fails does not
stop the review; the review carries on with fewer sources. The report
says so in that line and nowhere louder. `/consensus-review:doctor`
finds these problems before you rely on a review.

## The single-dimension commands

`/impact-review`, `/quality-review`, `/test-review` and `/arch-review`
run one agent, with the same severity bars and no consultant, arbiter or
sceptic. They take a scope (empty for the working tree, a PR, a range
such as `main..HEAD`, or a path) and `lang=`.

`/architecture-audit` is different: it reviews the whole project's
architecture, not a diff, and is heavier.

## Code graphs

Agents use a code graph when the repository has one
(`.codegraph/codegraph.db` or `graphify-out/graph.json`) and grep when it
does not. The plugin never builds one. A graph reflects its last build,
so agents use it for existing code and the diff itself for new symbols.
The doctor warns when the graph is older than the last commit.
