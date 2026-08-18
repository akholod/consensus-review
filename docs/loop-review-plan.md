# Loop Review Plan

## Status

Accepted for implementation planning.

Date: 2026-08-17

## Goal

Add a faster and cheaper cyclic PR/diff review strategy alongside the existing
multi-source `consensus-review` strategy. The new strategy must perform several
differentiated discovery passes because a single model pass does not reliably
find all supported issues.

## Accepted packaging decision

`loop-review` will be delivered in the existing `consensus-review` plugin
package, but as an architecturally separate command and runtime.

- Keep `/consensus-review` as the existing parallel, multi-source strategy.
- Add `/loop-review` as the sequential, coverage-directed cyclic strategy.
- Implement the loop in a dedicated executable runtime, not as a large
  conditional branch inside `commands/consensus-review.md`.
- Share stable contracts where useful: target resolution, finding schema,
  severity and admission rules, verification protocol, and report primitives.
- Do not make either command depend on the other's orchestration.

Target layout:

```text
consensus-review/
├── commands/
│   ├── consensus-review.md
│   └── loop-review.md
├── bin/
│   └── loop-review.mjs
├── src/loop-review/
│   ├── context-builder
│   ├── instruction-filter
│   ├── risk-classifier
│   ├── discovery-loop
│   ├── verifier
│   ├── coverage-ledger
│   ├── finding-memory
│   ├── reporter
│   └── runner/
└── prompts/loop-review/
```

Do not expose the new strategy only as `/consensus-review --mode loop`. The two
strategies have different state, budgets, failure semantics, and execution
graphs. A shared umbrella command such as `/review --strategy loop|consensus`
can be considered after both strategies have stable contracts.

## Required behavior

### Inner review loop

The inner loop operates on one immutable diff snapshot.

1. Resolve the target and compute its diff hash.
2. Build and cache review context once.
3. Classify changed surfaces and mandatory risk cells.
4. Run differentiated discovery passes:
   - breadth and contract discovery;
   - complementary search over uncovered risks;
   - residual search when a new theme or coverage gap remains.
5. Deduplicate findings through persistent finding memory.
6. Batch-verify actionable findings adversarially.
7. Finish as `CLEAN`, `FINDINGS`, `INCONCLUSIVE`, or `ESCALATE`.

Pass policy:

- Documentation, generated code, and formatting-only changes: zero or one
  lightweight pass.
- Every non-trivial code diff: at least two discovery passes.
- High-risk auth, permission, migration, destructive-data, public-contract, or
  cross-service changes: at least three passes, with a hard maximum of four
  before escalation.

Later passes receive compact finding fingerprints, refuted claims, and coverage
gaps. They must not receive persuasive reasoning that encourages repeating the
dominant theme.

### Outer review-after-fix loop

The MVP is read-only. A human or a separate agent applies fixes, then runs
`/loop-review` again.

- Recompute the diff hash after every fix.
- Start a new inner loop when the diff changed.
- Keep the previous run state for audit and finding-resolution comparison.
- Never assume that a missing old finding was fixed without rechecking its
  anchor and affected dependency closure.

## Context and instruction selection

Reuse the deterministic ideas from `duo-review-local.mjs`:

- merge-base and diff parsing;
- rename, binary, and generated-file handling;
- changed-line mapping;
- capped pre-change file content;
- bounded related-file reads;
- token, call, and time accounting.

Treat `.gitlab/duo/mr-review-instructions.yaml` as policy configuration, not as
one prompt. For each instruction group:

1. Match positive `fileFilters` globs against changed files.
2. Apply `!pattern` exclusions.
3. Attach only the matching instruction group to the relevant file or cluster.
4. Send only those selected groups to the model.

Custom instructions are untrusted advisory input. They cannot override
read-only restrictions, runner permissions, budgets, admission rules, stopping
rules, or escalation rules.

## Runner decision

Do not reuse the direct Anthropic HTTP client or API-key loading from
`duo-review-local.mjs`.

All model execution goes through a local runner adapter:

```text
RunnerAdapter.run(prompt, role, modelHint, timeout, maxTokens)
  -> content, usage, modelId, runnerId
```

Initial adapters:

- `claude -p` as the default;
- `codex exec` as an alternative;
- an OpenCode-native subagent adapter when available.

The runtime owns response parsing, schema validation, timeouts, and usage
accounting. It does not load provider credentials or depend on GitLab AI
Gateway prompts or GitLab's XML review contract.

## Shared contracts from consensus-review

Reuse or version consistently:

- P0/P1 requirement for a reachable failure scenario;
- P2 requirement for concrete project-specific evidence;
- normalized finding categories and severity;
- adversarial `confirmed | reduced | unconfirmed | refuted` verification;
- explicit unavailable, truncated, and inconclusive states;
- Markdown report structure where it does not obscure loop-specific state.

Do not reuse by default:

- the complete parallel reviewer panel;
- repeated independent repository exploration;
- majority voting for every pass;
- direct coupling to the consensus arbiter.

## Completion and escalation

`CLEAN` means only: no confirmed findings within the reviewed scope.

It requires:

- the minimum number of discovery passes;
- evidence-backed coverage of mandatory risk cells;
- no unresolved candidates or verifier backlog;
- no failed or truncated pass;
- an unchanged diff snapshot;
- a final complementary pass with no new confirmed finding.

Budget exhaustion, incomplete context, runner failure, or uncovered mandatory
risk cells produce `INCONCLUSIVE`, never `CLEAN`.

Escalate to human review or `/consensus-review` for suspected P0, unresolved
high-risk findings, reviewer/verifier disagreement, incomplete high-risk
context, or a new theme discovered on the final allowed pass.

## Implementation phases

### Phase 0: Contracts

- Specify `RunState`, `Finding`, coverage-cell, and runner-adapter schemas.
- Define prompt inputs and structured outputs for every pass.
- Define budgets, completion, stale-state, and escalation rules.

### Phase 1: MVP

- Add the `/loop-review` command and executable runtime.
- Support worktree, git range, and PR targets already supported by the plugin.
- Build context once and run the mandatory differentiated discovery loop.
- Add finding memory, batched verification, JSON state, and Markdown output.
- Implement the `claude -p` adapter and hard resource budgets.
- Keep repository access and behavior read-only.

### Phase 2: Integration and calibration

- Add optional `codex exec` and OpenCode-native adapters.
- Add diff-hash-gated resume and review-after-fix comparison.
- Add graph-aware dependency closure when an existing code graph is available.
- Consider a cross-runner verifier only if evaluation demonstrates enough value.

### Phase 3: Evaluation and routing

- Compare one-shot, loop-review, and consensus-review on the same PR corpus.
- Measure precision, seeded/human-adjudicated recall, false-clean rate,
  verifier overturns, duplicate rate, time, tokens, and cost per confirmed
  finding.
- Add `/review --strategy loop|consensus|auto` only after routing thresholds are
  supported by measurements.

## Success criteria

- Every non-trivial code review executes at least two distinct discovery passes.
- No pass re-runs full repository exploration by default.
- Matching custom instructions are selected per changed file or cluster.
- No direct provider HTTP client or credential loading exists in loop-review.
- Failed, truncated, stale, or under-covered runs cannot report `CLEAN`.
- Existing `/consensus-review` behavior remains unchanged.
- Evaluation shows lower median time and token usage than consensus-review while
  preserving an acceptable high-severity finding rate.

## Review triggers

Reconsider packaging loop-review as a separate plugin only if it develops an
independent release lifecycle, heavy or incompatible dependencies, a different
host integration, or a clear requirement for separate installation and
enablement.
