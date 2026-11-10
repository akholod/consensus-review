# arch-review — measurements

Measurements for the `architecture` dimension (`agents/arch-reviewer.md`): when the
architecture lane runs, does it catch module-boundary and contract violations, and do those
findings survive the sceptic? Whether the lane runs at a given tier is out of scope. Every number
here is specific to the fixture below.

## Fixture

`test/fixtures/arch-review/{base.patch,change.patch,answer-key.json}` holds a small ESM Node
repository, "shopfront", stored as two patches. Materialise it with
`node testkit/review-fixture.mjs <dir> arch-review`: the base is committed and the change is
staged, uncommitted. `test/unit/arch-review-fixture.test.mjs` validates the key:
- the key partitions the 30 changed files;
- every fact and anchor sits on the line the key gives;
- each entry applies on its own (`materialize(dir, { include: entry.files })`);
- the named consequences happen when the seeded code runs: S2, S3, S6–S9, H4–H7, C1, C2 and C4.

The fixture's own rules are in `docs/architecture.md`, `docs/api.md` and `docs/events.md`:
- browser code reaches the server only through the generated client and its `parse*`;
- a module is used only through its `index.js`, which never hands out the module's state; its other files and `_` fields are private;
- an explicit dependency direction;
- table ownership;
- money in integer cents and durations in `…Ms`;
- the public API v1, events and config keys are contracts.

These rules are the project-specific anchors that the P2 admission bar asks for.

| Set | Entries | Families |
|---|---|---|
| original | S1–S9 | layer, internals in, internals out, weakened barrier, dependency direction, semantic change (×2), breaking API change, boundary contract (raw response and a local DTO) |
| holdout | H1–H8 | the same families in a different form, plus union shape and table ownership |
| control | C1–C4 | additive API field, internal refactor behind a stable API, an allowed edge, a new versioned event with a same-module `internal/` import |

The holdout set is scored on every run but never used to design a prompt change. A prompt change
is written in a fresh context that has opened neither this file's per-seed details nor the
fixture.

## Protocol

Plugin copy: the 65 files of `npm pack --dry-run` from the working tree. The prompt hashes are
recorded below.

- **FX ×3**, the agent alone. Each run gets a fresh `R=$(mktemp -d)` that holds only the
  materialised fixture. The prompt is `/consensus-review:arch-review` with an empty scope, which
  reviews the working tree. Flags:
  `claude -p --setting-sources project,local --plugin-dir <copy> --model sonnet --permission-mode dontAsk`,
  with the FX allow list from `docs/design/test-review-measurements.md`.
  `arch-reviewer` runs on its pinned model (opus, effort medium).
- **E2E ×2**, the full path. The prompt is `/consensus-review:consensus-review dims=architecture deep`:
  T3, the strict sceptic, the architecture lane and the consultant only. Flags:
  `--permission-mode auto --model opus`, with no `bypassPermissions`. `.reviews/` is added to
  `R/.git/info/exclude` so that the archive step can run.
- **Validity.** For FX, the run made exactly one `arch-reviewer` dispatch, used only the copy
  plugin, and its child did not touch the source checkout, `~/.claude/` (except its own session's
  tool-results spill file) or another run's `R`. For E2E, the pipeline reached its final report.
- **Rows.**
  - FX: the `### Findings` table, with `claim` = Title + " — " + Risk & Correction. The items under
    `### Open Questions / Hypotheses` are kept separately.
  - E2E: the final report's entries, each with its section, sources and sceptic decision.
  - `R`'s absolute prefix is stripped from every row.
- **Scoring.** Blind and in batches, by a fresh opus session with no plugin and only `Read`, `Grep`
  and `Glob`. The scorer receives the rules block below, the key, a freshly materialised fixture
  and the shuffled neutral rows `{id, location, claim, severity}`. It does not see the run or the
  source.

## Scoring rules (frozen)

The scorer receives this section as written. Its hash is recorded below before any scored run.

<!-- rules:begin -->
**Labels.** Each review row is `{id, location, claim, severity}`. Label it `hit:<id>`, `false` or
`real-unplanted`, with a one-line reason; cite a `file:line` for `false` and `real-unplanted`.

**Match rules.**
- A hit needs both of these:
  - a location in one of the seed's `files` or `also` files (any line), or in a fixture doc (`docs/*.md`) when the claim names one of the seed's `files`;
  - a claim that states the seed's `match.mechanism` as a problem, or any one of its `match.consequences`.

  A row that only describes the code ("adds an import of db.js") without saying what is wrong with it is not a hit. For each hit, also record `trace: yes` when the claim states one of the seed's consequences, and `trace: no` when it states only the mechanism.
- A seed counts once per run. A row may hit several seeds, but only if its location lists a file that passes the location test for each one and its claim states each one's match; label it `hit:<id>+<id>…` and count it as `merged`. Otherwise a row that touches two seeds hits the seed whose `files` hold its first location.
- `false` is a claimed problem with a control's change (the lines in its `changed`) that the control's `note` contradicts, or any row the scorer refutes from the code.
- `real-unplanted` counts neither way.
- Question items (Open Questions / Hypotheses) are not rows. Each gets `q:<id>` when it states a seed's match under the same location test, and `none` otherwise. A seed with a hit in the run is not also counted as `q`.

**Metrics.**
- **Per run:**
  - H_orig: seeds hit among S1–S9;
  - H_hold: seeds hit among H1–H8;
  - F: `false` rows;
  - sev-ok: hits whose row severity is in the seed's `accepted`;
  - Hq: seeds with only a `q` label;
  - merged: rows that hit more than one seed;
  - trace: hits with `trace: yes`.
- **E2E, per seed,** read from the final report:
  - `reported`: an entry under `## P0`, `## P1` or `## P2` hits the seed;
  - `parked`: the seed is hit only by an entry under Unconfirmed, Unverified, or Dropped / Downgraded;
  - `absent`: no entry hits it.

  Record each hitting entry's sources and sceptic decision. A seed counts as caught by `arch-reviewer` when `claude` is among the sources of a `reported` entry.
<!-- rules:end -->

## Decision rule (frozen with the rules)

- A seed is **covered** when it is hit in at least 2 of 3 FX runs and is caught by
  `arch-reviewer` in at least 1 of 2 E2E runs.
- A seed is **lost at the sceptic** when it is hit in at least 2 of 3 FX runs, and in every E2E run
  where an `arch-reviewer` finding hits it, that finding is `parked`.
- A seed is **missed** when it is hit in at most 1 of 3 FX runs. Before any prompt change, a missed
  seed is re-run alone: a fixture with only its entry applied (`include: entry.files`), one FX
  run. That tells a blind spot apart from crowding in a 30-file diff.
- **What to change next:**
  - 2 or more original seeds lost at the sceptic → first a `finding-verifier` line for
    architecture findings;
  - 2 or more original seeds missed after the alone re-run → a prompt change for those families.

  Holdout results are reported but never drive a change.

## Hashes (frozen 2026-11-09, before any scored run)

| Artifact | sha256 |
|---|---|
| `test/fixtures/arch-review/answer-key.json` | `70c8aeeb5acc4ce7ee4a89858d3e3790e1f03254bb1e1eb3573fa9518486aadc` |
| `test/fixtures/arch-review/base.patch` | `bf45e9f72c5b902f109ddd7fe4db891817d8008a9cdcb02038dc78c1472ab78e` |
| `test/fixtures/arch-review/change.patch` | `1c2af0c1626b3c972e6a7e156afa83590cc77a5c6ae735181a70975002931b5e` |
| the rules section above (bytes strictly between the two markers) | `7ac732bce40f570fa93040449a3ac77b5a6f557b60947eeabbdb88a1f60d8822` |

The decision rule above is frozen at the same moment.

Measured prompts (unchanged from `5ffedd9`):

| File | Bytes | sha256 |
|---|---|---|
| `agents/arch-reviewer.md` | 11799 | `b07c349a55dd2d3fa06358d334fd95615dafbe3d3558659928510ff298e50879` |
| `agents/finding-verifier.md` | 5667 | `fb1a827134820b0e4c16e0d1ce5f45d2a7c872c640dd388461e430280d1d4131` |
| `commands/arch-review.md` | 1234 | `bf5c90bc3e2dfff1a982df26894405359d7d681cf49eda87f1346aef7fd6d312` |
| `commands/consensus-review.md` | 58688 | `2c3fc0485ca6670bd3991047adf8a74ac9f57cd7d267b02e7a2dd3fb97175751` |
| `contracts/severity-bars.md` | 1914 | `94842e6b62a61c72109530fc29c2640052bb5471a9f322db3fb756b2c3c9d96d` |

Reproduce:

```sh
sha256sum test/fixtures/arch-review/{answer-key.json,base.patch,change.patch}
sed -n '/^<!-- rules:begin -->$/,/^<!-- rules:end -->$/p' docs/design/arch-review-measurements.md | sed '1d;$d' | sha256sum
```

Environment at freeze: node v24.16.0, Claude Code 2.1.321.

The key was reviewed adversarially twice before the freeze, by a separate agent reading the
materialised tree. The fixes it led to:
- base rule 2 names module state, with constants allowed;
- `reports` is documented, and its entry file is `index.js`;
- CI runs `npm install`;
- the base commit identity looks real;
- `match` is split into a mechanism and its consequences;
- the controls have `changed` line ranges;
- S7 gets the web-client locations;
- the severity bands were adjusted.

## Pilot (mechanics, not scored)

PILOT-1 ran on 2026-11-09 at 18:21 UTC (session `a4d5384c-a3bb-49d2-a889-c04f55b7f201`) and cost $0.58.
- **Validity.** Valid: one `arch-reviewer` dispatch, 0 violations.
- **What the child did.** 17 `Read` calls and 5 read-only `Bash` calls (`git`, `grep`, a
  `for … cat -n` loop).
- **Dispatch.** Async: the report is the child's last message.
- **Output.** 15 Findings rows and 5 question items. Its rows are kept apart and are not scored.

One row covered three seeds at once: the lint demotion and the two browser imports it lets
through. Under the earlier rule that a row hits only one seed, two seeds the review did find would
have counted as misses. So the rule now allows a `merged` row. The change was made before the
freeze.

## Results (baseline, 2026-11-09)

The rows of every run are scored blind, with no dispute filed. FX was scored by session
`af84397f-4f80-4a18-a39b-02121630514a` ($0.63): its one denied call was a `python3` one-liner,
and it labelled through `Read` instead. E2E was scored by session
`fa8ed633-a0b0-48a0-a09e-d33bc37f0b99` ($0.46).

| Run | Session | Cost | Rows | H_orig | H_hold | F | merged | sev-ok | trace | Hq |
|---|---|---|---|---|---|---|---|---|---|---|
| FX-1 | `b366df9c-d068-4001-b323-cdb675faa344` | $0.55 | 14 | 9/9 | 8/8 | 0 | 2 | 15 | 17 | 0 |
| FX-2 | `00d8404e-740b-464c-bf7e-c224c7e1fd60` | $0.45 | 15 | 9/9 | 8/8 | 0 | 1 | 17 | 17 | 0 |
| FX-3 | `65744cfb-16d0-4b60-bd05-8a401e4507cf` | $0.54 | 14 | 9/9 | 8/8 | 0 | 1 | 14 | 17 | 0 |
| E2E-1 | `0303f65a-462b-4591-b9ed-3c59eb787578` | $2.00 | 16 (P0 7, P1 4, P2 5) | 8/9 | 7/8 | 1 | 0 | 14 | 15 | 0 |
| E2E-2 | `b50eb888-af62-4416-b384-94a8b31ceb8f` | $2.02 | 14 (P0 6, P1 5, P2 3) | 8/9 | 7/8 | 0 | 1 | 14 | 14 | 0 |

Every run is valid:
- the FX runs show 0 compliance violations;
- both E2E runs reached the final report with codex `ok`, `codex-refuter` `ok` and the strict
  sceptic, and both have `permission_denials` `[]`.

The E2E F is a codex-only P2 on C3's file (`src/checkout/gift-card.js`), with the claim that the
new functions are not exported through `index.js`. The scorer refuted it.

**Per seed.**
- **FX.** All 17 seeds were hit in all 3 runs, and every hit states a consequence (`trace`).
- **E2E.** 15 seeds are `reported` with `claude` among the sources in both runs, and survived the
  sceptic. None is `parked`.
- **S4 and H1.** Both are `absent` in both E2E runs under the letter of the rules, but they are not
  lost. In each run `arch-reviewer`'s own row merged S1, S4 and H1, with all three files in its
  Location. The finding schema (`contracts/finding.schema.json`) has a single `file`/`line`, so the
  report entry kept only `src/ui/order-history.js:1`. Its rationale still names
  `eslint.config.js:8` and `src/ui/price-badge.js`.

**Sceptic.**
- No `arch-reviewer` finding was dropped or left unconfirmed.
- Severity changes happened in the arbiter or under the votes' `suggested_severity`:
  - S5 (the cycle) went from P1 to P2 in both runs ("no failure today");
  - H8 went from P1 to P2, and S8 from P0 to P1, in E2E-1;
  - S6 went from P2 to P0 in E2E-2, where codex supplied the consumer.

**Decision rule.**
- 15/17 seeds are covered.
- 0 are lost at the sceptic, and 0 are missed.
- S4 and H1 fall outside the three categories: they were found, then merged into another entry
  with their locations lost.

No threshold for a change is met, so no `finding-verifier` or prompt change is indicated.

**Limits of this result.**
- **Ceiling.** 17/17 in every FX run means this fixture cannot tell a good prompt from a better
  one.
- **What it shows.** When a project writes its boundary and contract rules down and a diff breaks
  them plainly, `arch-reviewer` finds the breaks, traces the consumers, and its findings survive
  the sceptic.
- **What it does not show.**
  - Rules that exist only implicitly in the code structure.
  - A realistic density, where 1–2 violations sit among ordinary changes rather than 17 in 30
    files.
  - Subtler forms: a cycle through a third module, a unit change with no name hint, a consumer that
    grep cannot find (DI, dynamic import, another repository).
- **Authorship.** The fixture was written by the same session that read the prompt.

**Found by the way.** A finding with several sites loses all but one location in the report.
`arch-reviewer` merges one rule broken at several sites into one row, and §6 normalisation keeps
one `file`/`line`.

Total eval cost: $6.64 ($1.53 FX, $4.02 E2E, $1.09 scoring), plus the pilot ($0.58).

## Several-sites fix (2026-11-10)

**Change.** `commands/consensus-review.md` §6 gains one bullet. When a finding names more than one site, the first site stays as `file`/`line` and `rationale` begins with `Also at: <every other site>`. The file is now 58952 bytes, sha256 `4858bf96e2b170895deae5812d158828d04248fba1aa95315258006e8b24aba9`, and no other file changed. The fix is generic: it is not worded after any seed.

**Measurement tool.** The E2E extractor adds the `Also at:` sites to an entry's location. It also learned report entries without an `F<n>` id. Scored ids were kept: E2E-1 and E2E-2 were re-extracted once by mistake, and their ids were restored from the scored batch by content, 30/30.

**Runs.**
- E2E ×2 (`copies/sites`, same flags as above), both valid, with codex, the refuter and the strict sceptic all `ok`:
  - SITES-1: `b2d2de9b-c76c-4948-bf94-14f3a0d85e15`, $2.02;
  - SITES-2: `7986c840-524b-41c4-aab0-eadba76d569e`, $2.07.
- Scored blind by session `eec844e3-396b-426b-8af0-498e72c0ee0d` ($0.45), with the same procedure.

| Run | Rows | H_orig | H_hold | F | merged | sev-ok | trace |
|---|---|---|---|---|---|---|---|
| SITES-1 | 16 | 9/9 | 8/8 | 1 | 1 | 14 | 16 |
| SITES-2 | 15 | 9/9 | 8/8 | 0 | 1 | 14 | 12 |

**Results.**
- **S4 and H1.** Both are now `reported` in both runs, as one entry with S1 whose location lists all three sites. All 17 seeds are covered.
- **F.** The one F is a claude-only P2 on control C1, claiming that `initials` is missing from `openapi.yaml`. That spec has no customers path at all. It did not appear in the four other E2E runs.
- **Sceptic.** In SITES-2, S8 went to P2 as `unconfirmed` (verifier: CONCERN, codex: AGREE), still in the P2 section. No seed was parked.

# Hard fixture: implicit rules, realistic PRs

The first fixture hit its ceiling. Its rules are written down, its violations are blunt, and there
are 17 of them across 30 files. This fixture removes all three advantages.

## Fixture

`test/fixtures/arch-review-hard/{base.patch,pr1.patch…pr6.patch,answer-key.json}` holds "meterly", a
subscription-billing service in ESM Node.
- **Materialise** one PR with
  `node testkit/review-fixture.mjs <dir> arch-review-hard prN.patch`. Each PR is staged and
  uncommitted on the same base.
- **Validation.** `test/unit/arch-review-hard-fixture.test.mjs` checks four things:
  - each PR's entries own exactly the lines it changes;
  - the facts and anchors sit on the lines the key gives, and every anchor file passes the location test;
  - every PR imports cleanly and passes its own tests;
  - every seed's consequence happens when the code runs.

**No rules are written down.** The README only lists the modules. The anchors are patterns in the
base:
- every cross-module import goes through a module's `index.js`;
- one module per table;
- HTTP errors only in `src/api/`, behind the `try`/`toResponse` shape;
- the adapter return contract is documented in the Stripe adapter's JSDoc;
- event subscribers are found by the event name;
- providers are found by the registry key.

| PR | Change | Seeds (set) |
|---|---|---|
| pr1 | admin CSV export | K1 internals in: `subscriptions/repository.js` bypassed (original) |
| pr2 | grace period configurable in hours | K2 unit change with no unit in the name; a reader elsewhere still uses days (original) |
| pr3 | metered pricing | K3 cycle through a third module (original); K4 a domain module throws `HttpError` (holdout) |
| pr4 | profile notifications, SMS opt-in | K5 event payload reshaped; the subscriber is found only by name (original); K6 cached state handed out and mutated (holdout) |
| pr5 | Adyen, voiding unpaid invoices | K7 provider swapped behind the registry with another return shape (original); K8 another module's table written directly (holdout) |
| pr6 | plan comparison | none: a clean PR |

Each PR's benign files are its control, C1–C6.

## Protocol

**FX ×2 per PR (12 runs).**
- Each run uses a fresh `R=$(mktemp -d)` with the PR materialised.
- The prompt is `/consensus-review:arch-review`, with the same flags and allow list as the first
  fixture, and `copies/head`.

**E2E ×1, for pr3, pr4 and pr5.**
- The prompt is `/consensus-review:consensus-review dims=architecture deep`, in auto mode.
- It runs with `copies/sites`, which is the current pipeline. The several-sites fix is
  orchestrator-only, so `arch-reviewer` itself is unchanged.

**Scoring.** One fresh opus session per batch. It gets all six PR trees and diffs. Each row
carries its `pr`, and the batch uses the rules below.

## Scoring rules, hard fixture (frozen)

<!-- hard-rules:begin -->
**Labels.** Each review row is `{id, pr, location, claim, severity}`. Label it `hit:<id>`, `false` or
`real-unplanted`, with a one-line reason; cite a `file:line` for `false` and `real-unplanted`.

**Match rules.**
- A row is judged only against the key entries whose `pr` is the row's `pr`.
- A hit needs both of these:
  - a location in one of the seed's `files` or `also` files (any line);
  - a claim that states the seed's `match.mechanism` as a problem, or any one of its `match.consequences`.

  A row that only describes the code without saying what is wrong with it is not a hit. For each hit, record `trace: yes` when the claim states one of the seed's consequences, and `trace: no` when it states only the mechanism.
- A run is one review of one PR, and a seed counts once per run.
- A row may hit several seeds of its PR only if its location lists a file that passes the location test for each one, and its claim states each one's match. Label such a row `hit:<id>+<id>…` and count it as `merged`.
- Otherwise, a row that touches two seeds hits the seed whose `changed` lines hold the row's first cited line, failing that the seed whose `files` hold it, and failing that the seed listed first in the key.
- `false` is either of these:
  - a claimed problem with a control's change (its `changed` lines) that the control's `note` contradicts;
  - any row the scorer refutes from the code.
- `real-unplanted` counts neither way.
- Question items (Open Questions / Hypotheses) are not rows. Each gets `q:<id>` when it states a seed's match under the same location test, and `none` otherwise. A seed with a hit in the run is not also counted as `q`.

**Metrics.**
- **Per PR review:** hits, F, sev-ok (hits whose row severity is in the seed's `accepted`), trace, Hq, merged.
- **Pooled over the FX runs:**
  - H_orig: (seed, run) hits over the seeds whose `set` is `original`, out of 5 × 2;
  - H_hold: the same over `holdout`, out of 3 × 2;
  - F in total, and F on pr6, the clean PR, separately.
- **E2E, per seed:** `reported`, `parked` or `absent`, defined as for the first fixture.
<!-- hard-rules:end -->

## Decision rule, hard fixture (frozen with its rules)

- A seed is **found** when it is hit in at least 1 of its 2 FX runs, and **stable** when it is hit
  in both.
- A seed is **missed** when it is hit in 0 of 2. That makes it a blind-spot candidate. The PR is
  already small, so there is no separate run alone.
- A seed is **lost at the sceptic** when it is found in FX but, in its E2E run, the
  `arch-reviewer` finding that hits it is `parked`.
- **What to change next:**
  - 2 or more original seeds missed → a prompt change for their families, written in a fresh
    context that has opened neither this fixture nor this section's per-seed table;
  - 1 or more original seed lost at the sceptic → a `finding-verifier` line for architecture
    findings;
  - an average of 1 or more `false` per pr6 run → a precision problem, reported.

  Holdout results are reported and never drive a change.

## Hashes, hard fixture (frozen 2026-11-10, before any scored run)

| Artifact | sha256 |
|---|---|
| `test/fixtures/arch-review-hard/answer-key.json` | `a6f91acec73d8ff2c1fb94401e31b4e4277bb980a000a82732e47cb58e4bebcd` |
| `test/fixtures/arch-review-hard/base.patch` | `cce3ae436a017fcd0124b5ff507f4ac11ff1cc77bfd313c1d0328ded5805f879` |
| `test/fixtures/arch-review-hard/pr1.patch` | `2f11372907274e94bcbfb380eadd459fff6a5b70daf92fd9e264efe700a34331` |
| `test/fixtures/arch-review-hard/pr2.patch` | `a0c2d730d050c1c6ebb90acd2d1db6d109ad10bb2ab3a09a29e6f3f6320ace98` |
| `test/fixtures/arch-review-hard/pr3.patch` | `419374547989423a50801188c049f2f131995f3160a3d70ef9415358eb18d67c` |
| `test/fixtures/arch-review-hard/pr4.patch` | `85c8d3aaf56af8da6c35364ec906bf7a66edca5d397bc3eb219e2dbd031296b1` |
| `test/fixtures/arch-review-hard/pr5.patch` | `8df665534e5f7e6bb3eb36a6e3d667842f4d437d73a57da41bc53e3b9583c11b` |
| `test/fixtures/arch-review-hard/pr6.patch` | `85a5265cb9ef030622f025b8fe75293eba3dec5d6489cf0f787bfd25315e9c0c` |
| the hard rules section (bytes strictly between its two markers) | `d8b9206aa385ebf43aaf0829e2fe92b03796d5cf3c8668722f46082c1900f0c1` |

The prompts are the ones listed in the first fixture's hashes. E2E also uses `commands/consensus-review.md` `4858bf96…` (the several-sites fix).

The key was reviewed adversarially before the freeze, by a separate agent in two passes. v1 was rebuilt as v2 after the first pass, which reported 12 problems:
- the reused rules could not score it;
- PR6 was not clean;
- K3 could be credited for the wrong cycle;
- K2 had no consequence that could be reached;
- `also` had gaps;
- C1 was dirty;
- K7 had a false consequence;
- there was a money path next to K8;
- the P0 seeds had no caller;
- the control notes were vague.

The second pass left three small fixes, all applied.

## Results, hard fixture (2026-11-10)

**Validity.** Every run is valid.
- **FX ×12** (`copies/head`): 0 compliance violations, $3.86 in total.
- **E2E ×3** (`copies/sites`): codex, the refuter and the strict sceptic were all `ok`, with
  `permission_denials` `[]`. Sessions:
  - pr3: `8b4d1a33-323d-4844-9a83-25d3b173a803`, $1.67;
  - pr4: `ecc29c7b-5df0-4494-9845-70f6763e2df2`, $1.57;
  - pr5: `3721f99f-ee65-47a3-b0d1-44654981be3a`, $1.55.
- **Scoring:**
  - FX: `f544a2f6-015b-473f-8052-dae8cfd86f76` ($0.97). One denied `python3` call; it labelled through `Read`.
  - E2E: `a50bd67d-9bfc-461a-abe4-b4c1cf8f1bd0` ($0.37).

| Seed | Set | PR | FX run 1 | FX run 2 | E2E |
|---|---|---|---|---|---|
| K1 internals in | original | pr1 | P1 +t | P0 +t | — |
| K2 unit, no name hint | original | pr2 | P0 +t | P0 +t | — |
| K3 cycle via a third module | original | pr3 | P1 +t | P1 +t | reported, P2 (downgraded from P1, `unconfirmed`: verifier CONCERN) |
| K4 domain throws `HttpError` | holdout | pr3 | P2 +t | P2 +t | reported, P2 |
| K5 event payload, subscriber found by name | original | pr4 | P0 +t | P0 +t | reported, P0 |
| K6 cached state handed out | holdout | pr4 | P0 +t | P0 +t | reported, P1 |
| K7 provider swapped behind the registry | original | pr5 | P0 +t | P0 +t | reported, P0 |
| K8 another module's table | holdout | pr5 | P1 +t | P1 +t | reported, P1 |

`+t`: the hit states a consequence (`trace: yes`). Each row lists the severity of the hitting row.

**Pooled.**
- **FX:** H_orig 10/10 and H_hold 6/6. All 16 (seed, run) hits state a consequence. Hq 0.
- **E2E:** all 6 seeds are `reported` with `claude` among the sources, and none is `parked`.
- **F:**
  - 2 in total, both on pr6 in FX-pr6-1; FX-pr6-2 reported nothing.
  - Both are P2 findings with a project anchor:
    - the handler returns plans' view unprojected, where `subscriptions-handler` maps fields
      explicitly;
    - `monthlyCents` means "per 30 days".
  - Under the rules they are `false`, because C6's note calls the PR clean. Read on their merits,
    they are defensible judgement calls, not invented problems.
- **`real-unplanted`:** 12 FX rows and 6 E2E rows, all true according to the scorer (for example,
  `periodPrice` has no billing caller, and `RENEWAL_GRACE_HOURS` is not validated).

**Decision rule.**
- 0 seeds missed and 0 lost at the sceptic.
- pr6 averages exactly 1 `false` per run, the threshold of the precision rule, so that is reported
  here. Its content is described above.
- No prompt change and no `finding-verifier` change is indicated.

**Observed in both fixtures.** A dependency-direction finding consistently ends at P2:
- S5 in all four E2E runs of the first fixture;
- K3 here, once as `unconfirmed`.

The verifier and the arbiter ask for a runtime failure, and a cycle has none today. The finding
stays reported, so nothing is lost; only its severity is lower than `arch-reviewer`'s P1. If
cycles should stay P1, the lever is a `finding-verifier` line that accepts an architecture-level
change-cost scenario as evidence. That is not measured here.

**Limits.**
- Each PR is small: 3–6 files in a 29-file repository that the reviewer can read whole.
- Consumer discovery by grep or by a code graph in a large repository is not measured.

Hard-fixture eval cost: $10.01, made up of $3.86 for FX, $4.79 for E2E and $1.34 for scoring.

## Post-measurement edits (not measured)

An independent review of the §6 change found a gap. When §7 merges two sources' findings, it did
not say what happens to their `Also at:` lists. §7 Dedup now says: "A merged finding's `Also at:`
(§6) is the union of its sources' sites, minus the one kept as `file`/`line`."
`commands/consensus-review.md` is now 59061 bytes, sha256
`bf2e92a6192a8ed27428467ceb873aaf85cff563650da304df606349aadd6371`. The SITES runs above used
`4858bf96…`, without this clause.

## Agent questions in the report (2026-11-10)

**Change.** `commands/consensus-review.md`:
- §6 copies every item of a dimension agent's question section into `$WD/questions.json`.
- §9 lists them under `## Open questions (ungraded)`: unverified and not counted in Totals.

**Runs.** E2E with `dims=architecture deep`, in auto mode. For each run, the items in
`arch-reviewer`'s own `Open Questions / Hypotheses` are compared with the report section.

| Run | Fixture | Rule wording | Agent items | In the report |
|---|---|---|---|---|
| Q-1 | first fixture | "keep every item" | 5 | 5 |
| Q-pr1 | hard pr1 | "keep every item" | 4 | 3: the arbiter dropped the routing question |
| Q2-pr1 | hard pr1 | "copy every item, however minor; never drop, merge or reword one away" | 4 | 4 |

The K1 suspicion reached the report in both pr1 runs: the export leaves out `past_due` although
those subscriptions are still billed. Only the architecture lane ran in these runs; the questions
of the other dimension agents go through the same rule but were not measured. Cost: $4.92 for 3
sessions.
