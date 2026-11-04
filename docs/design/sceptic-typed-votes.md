# Sceptic typed votes (issue #8)

## Design

Each sceptic vote, the verifier's and every refuter's, is
`{id, verdict, evidence, citation, suggested_severity}`
(`contracts/verdict.schema.json`), with `verdict` one of:

- `AGREE`: the finding holds; `evidence` gives the harm path at `file:line`;
- `DISAGREE_EVIDENCE`: `citation` is `{file, line, quote}`, the quote a
  contiguous verbatim excerpt of the reviewed code, no `...`;
- `DISAGREE_CONCERN`: a doubt that could not be grounded that way.

`run-lane decide --phase sceptic` checks every quote
(`scripts/lib/quote-check.mjs`) against the diff's new side and, outside
the diff, against the clone at `--head-sha` (blob reads, never a
checkout; the working tree in uncommitted mode; nothing in diff-only
mode). A quote that does not match within ±5 lines of the cited line
becomes a concern, named in `downgraded`. The check proves existence,
not relevance.

Rules per finding, with `A` = `AGREE`, `E` = verified `DISAGREE_EVIDENCE`,
`cast` = every valid vote (concerns included), in order:

1. no verifier vote → `unconfirmed`;
2. `E > A` and (verifier verified `DISAGREE_EVIDENCE` or `2·E > cast`) → `refuted`;
3. `A > E` and (verifier `AGREE` or `2·A > cast`) → `confirmed`, concerns attached;
4. otherwise → `unconfirmed`.

`basic` runs the same `decide` with no refuter lanes (`voteMode: basic`).
When the decision is missing or carries `error`, one fallback applies in
§8 and in `archive-run.mjs`, both through `fallbackVerdicts` in
`scripts/lib/lanes.mjs`: a single verifier `AGREE` (or legacy
`confirmed`) → `confirmed`, anything else → `unconfirmed`, never
`refuted`.

`perFinding.<id>` carries `votes`, `downgraded`, `label`, `notes` and
`render` (`label`, `concerns`, `refutation`, language-neutral tokens).
The report copies these; it never reads the raw payloads.

`test/unit/sceptic-corpus.test.mjs` compares the old and new rules on
constructed ballots. That measures the rules, not model behaviour.

## Real-PR comparison protocol

A paired comparison, run by hand: it uses live models and is not part
of `check:all`. #8 stays open until it is done; the merge may come
first. Each PR runs twice, so the cost is 2× strict runs, up to about
4×T of wall clock each.

1. **Pick 3–5 PRs.** Real, already merged, each with at least one P0/P1
   from a past review. Prefer findings with a known outcome (fixed later,
   or confirmed noise). Pin each PR to its head SHA and use the same
   local clone for both runs.
2. **Two plugin versions.**
   - old: `git worktree add <tmp>/cr-old 1a48df2`, loaded with
     `claude --plugin-dir <tmp>/cr-old`;
   - new: the branch, loaded the same way from its own worktree.
3. **Run each PR twice with identical settings:** `sceptic=strict`, the
   same tier, consultant, `timeout`, `lang` and model versions, archives
   on, close together in time, in either order.
   - A `truncated` vote payload in any `meta.json` marks that PR
     incomplete.
   - Pair check: both archives have the same `meta.json` `diffHash`,
     equal to sha256 (first 16 hex) of the `gh pr diff` bytes at the
     pinned head SHA, computed as in `archive-run.mjs`. A mismatched pair
     is rejected and re-run.
4. **Score each run under its own rule**, from its own report and
   `decisions/sceptic.decision.json`.
5. **Match and label.** Match findings across the two runs by `file`,
   line neighbourhood and meaning. Label each P0/P1 `real` or `false` by
   hand, with a one-line reason. A finding only one run produced is
   labelled and counted for that system alone.
6. **Record per PR and per system:**
   - primary: real findings kept (TP kept) and false findings dropped
     (FP dropped);
   - how often a refuter changed the outcome, on the V CONCERN + R
     EVIDENCE rows, the V AGREE + R EVIDENCE rows and 3-voter splits;
   - how many `DISAGREE_EVIDENCE` votes were downgraded, and why
     (`cannot verify outside diff`, head object missing locally, drift,
     elided quote), the missing-object share separately;
   - secondary, labelled "rule effect on typed ballots": the old rule
     replayed on the new run's ballots with the conversion from
     `sceptic-corpus.test.mjs`. Not an effectiveness number.
7. **Publish** the table, the PR list with SHAs and the cost as a comment
   on issue #8, and copy them here. Effectiveness wording in the docs or
   CHANGELOG may cite only the primary paired numbers. One run per
   system on 3–5 PRs is noisy: a difference of 1–2 findings is reported
   as inconclusive.

## Results

Pending.
