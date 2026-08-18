<!-- STATUS: IMPLEMENTED on branch feat/loop-review. Plan approved via /ralplan consensus
     (Planner -> Architect -> Critic, 3 iterations); implementation verified via /ralph with 13
     adversarial review rounds. See "Implementation status" below for deviations. -->

# loop-review — implementation plan (v5, PENDING APPROVAL)

Target: `/home/andrii/opencode_sanbox/consensus-review`, branch `feat/loop-review`, off `main` @ `1f1189b` (v0.7.0).
Baseline requirement doc: `docs/loop-review-plan.md` (status: **Accepted**) — authoritative; this plan implements it, it does not amend it.
History: v1 → Architect → v2 → Critic **REJECT** → v3 → Architect (*"overcorrected"*) → v4 → Critic **ITERATE** → **v5**.

---

## 1. RALPLAN-DR summary

### Principles

1. **The accepted draft is authoritative.** Its required behaviours — including the 2 / 3 / max-4 pass policy and custom-instruction consumption — are implemented, not renegotiated by the planner.
2. **Determinism only where drift is fatal.** Code owns state, context, budgets and bookkeeping; prompts own all review reasoning. No review logic in JavaScript.
3. **`CLEAN` is a claim about the run, not about the code.** Coverage must be evidenced, not merely dispatched.
4. **One definition per contract, mechanically generated.** The F3 regression is the precedent.
5. **`/consensus-review` keeps its runtime behaviour**, byte for byte.
6. **Unverified mechanism is a hypothesis, not a design.** Anything the plan cannot demonstrate is labelled and tested before it is relied on.

### Decision drivers

1. Enforceability of the completion contract — "failed, truncated, stale, or under-covered runs cannot report `CLEAN`" is control flow, not an instruction.
2. Cost structure dominated by repeated repository exploration.
3. A maintenance surface in a repo that has never carried code.

### Options

**A — 4-module dependency-free Node runtime. CHOSEN.** The `CLEAN` conjunction, pass minima, diff-hash gating, budgets and the stopping rule become control flow; `--allowed-tools` hard-restricts a pass to prebuilt context; the deterministic half becomes unit-testable.

**B — markdown/subagent orchestration. Invalidated unconditionally.** Two accepted success criteria are inexpressible in it: the `CLEAN` conjunction, and "no pass re-runs full repository exploration" — unenforceable against a subagent holding Read/Grep/Bash. A poor cost result changes the runner design, never the guarantee model.

**`/consensus-review --mode loop`** — fuses a second execution graph onto the most-edited region of the codebase. **Separate plugin** — no mechanism to share the contracts, which are the main asset.

### 1.4 What changed from v4, and why

| v4 | Why it failed | v5 |
|---|---|---|
| Phase 0 calibrates the mandatory pass count | The 2 / 3 / max-4 policy is in the accepted draft; a negative spike result would have licensed an unapproved one-pass design | **Accepted policy stands unchanged.** Pass-count evaluation moves to Phase 3 |
| Phase 0 builds a corpus, recovers historical ground truth, adjudicates, repeats runs | Corpus work before the runtime exists; inflated for one person | Phase 0 is a **narrow technical spike** — adapter, cache, isolation. No corpus, no adjudication |
| §1.6 "the opposition dissolves" | `claude -p` exposes no cache-control or breakpoint option, so prefix caching across subprocesses is unestablished | Stated as a **hypothesis with a concrete experiment**; the fallback is named |
| Custom instructions: native JSON only, YAML deferred | The accepted draft requires consuming `.gitlab/duo/mr-review-instructions.yaml`; a scope note is honest, not compliant | **Bounded YAML compatibility restored to the MVP** |
| "false-clean below threshold" | No number, no denominator | Numeric rule, §3 |
| Fixture manifest dropped between v3 and v4 | A regression I introduced | Restored, compact |
| "git state never touched" | The PR fallback at `commands/consensus-review.md:56` runs `git fetch` | Write-surface contract narrowed precisely |
| Release compat gate in prose | No command, no version range, no artifact | Specified, §3 |

### 1.5 Standing defence: PR mode stays

The Architect wanted PR mode cut for "forge API auth, pagination, comment synchronization". The released command already resolves PR targets at `commands/consensus-review.md:50-58`: `gh pr diff` plus one metadata call, with documented fallbacks. There is no pagination and no comment synchronisation — the tool never posts. The Critic verified this independently and agreed. PR mode is reuse of a solved path and the accepted draft asks for exactly "PR targets already supported by the plugin".

### 1.6 Isolation vs. prompt cache — an open hypothesis, not a resolved design

Isolated `claude -p` subprocesses enforce the negative-space boundary but may pay cold-cache on every pass; batching or a persistent session would restore cache reuse **but would not preserve the same isolation guarantee**, and is therefore not a fallback for it.

*Hypothesis:* Anthropic prompt caching matches on request prefixes rather than on a session, so two sequential `claude -p` invocations sharing a byte-identical static prefix may reuse one cache entry. This is **not established** — the documented `claude -p` interface exposes no cache-control or breakpoint option, and caching additionally carries TTL, minimum-length, model and workspace constraints.

*Experiment (Phase 0):* run two sequential `claude -p` processes over an identical static prefix and require observed `cache_creation_input_tokens` on the first followed by `cache_read_input_tokens` on the second. Prefix stability is enforced by a unit test, which is a precondition, not proof.

*If it fails:* keep process isolation and the accepted pass minima, and absorb the cost — the exploration saving is measured separately. Do not switch to a shared conversation.

---

## 2. Pre-mortem

**1 — the loop adds cost, not recall.** *Earliest signal:* Phase 3 corpus comparison shows loop cost per confirmed finding above `/consensus-review` at T2. *Change now:* observability ships in Phase 2, so the Phase 3 comparison has data from real runs rather than a retrofit.

**2 — `CLEAN` becomes a lie.** *Earliest signal:* any seeded mandatory or high-risk defect undiscovered in a run that reported `CLEAN`, during Phase 2 acceptance — before release. *Change now:* per-cell evidence records with runtime validation, independent verification of high-risk cells before `CLEAN`, and the numeric rule in §3.

**3 — the runtime rots.** *Earliest signal:* the adapter compatibility check failing at the release gate — no release proceeds without it. *Change now:* deterministic CI from Phase 1, the compat command and supported-version range specified below, and every adapter failure mapping to `INCONCLUSIVE`.

---

## 3. Test plan

Layout `test/unit/`, `test/fixtures/`, `test/e2e/`; runner `node --test test/` (zero dependencies).

- **Unit** — diff parsing (renames, binary, new, deleted); generated-file detection; changed-line mapping; content capping; glob matching (positive globs then `!` exclusions); cell derivation; diff hashing (stable on rerun, changes on any edit); prompt-prefix byte-stability across passes; fingerprint generation from structured fields only; budget accounting; the stopping-rule state machine over all four terminal states; the bounded YAML subset parser.
- **Adapter fixtures** — `test/fixtures/adapter/{ok,malformed,truncated,timeout,exit-nonzero,refusal}.json`, each asserting a specific terminal state; a table test asserts none yields `CLEAN`.
- **Contract parity** — `node scripts/gen-contracts.mjs --check` regenerates the fenced block in `commands/consensus-review.md` from `contracts/finding.schema.json`; non-zero exit on drift. Mandatory in CI.
- **Verdict compatibility** — normalization asserted against `agents/finding-verifier.md:44-48`; `reduced` = `confirmed` + lower `suggested_severity`.
- **Hostile input** — an instruction file attempting to relax read-only, budgets, admission, stopping or escalation rules must be clamped.

**Seeded fixture manifest** (`test/e2e/seeded/`, restored after v4 dropped it):

| ID | Cell | Defect | Expected terminal state |
|---|---|---|---|
| SD-01 | migration / data | destructive column drop, no rollback | `FINDINGS` P0 |
| SD-02 | auth / permission | authorization check removed on one branch | `FINDINGS` P0 |
| SD-03 | contract / API | response field meaning changed, name kept | `FINDINGS` P1 |
| SD-04 | correctness | off-by-one in a changed loop bound | `FINDINGS` P1 |
| SD-05 | error handling | swallowed exception on a new I/O path | `FINDINGS` P2 |
| SD-06 | — | clean refactor, no defect | `CLEAN` |
| SD-07 | — | adapter truncation mid-run | `INCONCLUSIVE` |
| SD-08 | migration / data | high-risk cell with context unavailable | `ESCALATE` |

Commands: offline orchestration `node --test test/e2e/` (transcript replay — asserts pass counts, state transitions, stale-diff detection, the `CLEAN` conjunction); live recall `node bin/loop-review.mjs --target test/e2e/seeded --json` run explicitly, 2 repetitions, results appended to `docs/loop-review-measurements.md`. Transcripts cannot establish recall and are not used for it.

**False-clean rule (numeric):** across the seeded fixtures, **zero** runs may report `CLEAN` while any seeded mandatory or high-risk defect (SD-01, SD-02, SD-08) remains undiscovered. Any such occurrence fails Phase 2 acceptance outright.

**Release compatibility gate:** `node scripts/compat-check.mjs` issues one live `claude -p --output-format json` call and asserts the response envelope still parses into the adapter's expected fields. Supported range recorded in `package.json` (`engines.node: >=20`) and in `contracts/adapter.md` (the `claude` CLI versions the fixtures were recorded against). No release without a green run; the result is pasted into the release checklist in `docs/RELEASING.md`.

**Observability** — JSONL run log from Phase 2: per pass, model, tokens in/out, `cache_read_input_tokens`, wall time, findings added/deduped, cells directed, cells with valid evidence, verdicts; per run, terminal state and reason.

**Write-surface contract.** "Read-only" governs reviewed source and external systems. Permitted writes: the report destination, the run-state/log directory under a temp dir, and measurement docs. **Carve-out:** PR mode's `gh`-unavailable fallback fetches into a temp git dir, never the invoking repository — the e2e assertion verifies the invoking repo's `git status` and ref set are unchanged. The tool never posts PR comments, never edits reviewed source, and `no-file` suppresses the report write.

**Not tested:** model output quality — measured on the corpus in Phase 3, never asserted in CI.

---

## 4. Phased plan

### Phase 0 — narrow technical spike (~half a day, throwaway)

No corpus, no adjudication, no pass-policy decisions. Three questions only:

1. **Adapter behaviour** — capture real `claude -p --output-format json` responses for the six fixture states; these become `test/fixtures/adapter/`.
2. **Cache** — the two-process prefix experiment in §1.6; record `cache_creation_input_tokens` and `cache_read_input_tokens`.
3. **Isolation** — confirm `--allowed-tools` actually prevents repository exploration by a pass.

Output: recorded fixtures plus a short findings note. If (2) fails, the plan proceeds unchanged and the cost result is recorded for Phase 3.

### Phase 1 — contracts and CI

- `contracts/finding.schema.json` (canonical), `contracts/severity-bars.md`, `contracts/adapter.md`.
- `scripts/gen-contracts.mjs` generates the fenced block inside `commands/consensus-review.md`; `--check` fails on drift. **The released command's runtime behaviour is unchanged** — the block is simply no longer hand-maintained.
- Normalized vocabulary `confirmed | reduced | unconfirmed | refuted`, `reduced` derived. `agents/finding-verifier.md` untouched.
- Schemas for `RunState`, `Finding`, coverage cells, evidence records; budgets; completion, stale-state and escalation rules.
- **CI (deterministic only):** `node --test`, `gen-contracts --check`, `claude plugin validate`.
- **Acceptance:** CI green; `--check` fails on a deliberately corrupted block; `/consensus-review` byte-identical on a fixed sample diff before and after.

### Phase 2 — MVP runtime

`context.mjs` (diff, classification, cells, instruction selection) · `loop.mjs` (passes, ledger, finding memory, verification, stopping rule) · `adapter.mjs` (`claude -p`) · `report.mjs`, plus `commands/loop-review.md` and `prompts/loop-review/*`.

1. Targets: worktree, git range, **PR** (reusing `commands/consensus-review.md:50-58`, with the temp-dir fetch carve-out).
2. Context built once; passes hard-restricted from repo exploration; prompt prefix byte-stable across passes.
3. **Pass policy exactly as accepted:** 0–1 lightweight pass for docs/generated/formatting-only; **≥2** for every non-trivial code diff; **≥3** for auth, permission, migration, destructive-data, public-contract or cross-service changes, hard **maximum 4** before escalation.
4. **Custom instructions** — bounded YAML subset parser (no `ruby` shell-out, unlike `duo-review-local.mjs:130-146`) reading `.gitlab/duo/mr-review-instructions.yaml`, plus a native JSON format. Positive globs then `!` exclusions, attached per file cluster. Untrusted: cannot relax read-only, budgets, admission, stopping or escalation rules.
5. **Negative-space handoff** — payload is exactly fingerprints `(file, line-range, category, one-line claim)` derived from structured fields, refuted claims, and uncovered cells. Prior-pass rationale structurally absent, asserted on the constructed prompt.
6. **Per-cell evidence records** — supplied context segments, inspected anchors, checks performed, context-completeness, candidate disposition. Missing or malformed → cell not covered. High-risk cells additionally require independent verification before `CLEAN`.
7. **Batched adversarial verification** of actionable findings.
8. **Structured JSON run state** + JSONL log; hard token/call/time budgets; escalation conditions.
9. Report contract reusing consensus-review's report primitives where they do not obscure loop state.
10. Terminal states `CLEAN | FINDINGS | INCONCLUSIVE | ESCALATE` with the full `CLEAN` conjunction.

- **Acceptance:** all suites green; the numeric false-clean rule holds; every seeded fixture reaches its expected terminal state; no failure fixture reaches `CLEAN`; hostile-instruction test passes; `/consensus-review` byte-identical.

### Phase 3 — evaluation and routing

Corpus comparison across one-shot / loop / consensus on the same PR corpus: precision, seeded and adjudicated recall, false-clean rate, verifier overturns, duplicate rate, time, tokens, cost per confirmed finding. **Pass-count evaluation lives here**, with the accepted minima as the baseline to beat. Then `codex exec` and OpenCode adapters, diff-hash-gated resume and review-after-fix comparison, graph-aware closure. `/review --strategy loop|consensus|auto` only once routing thresholds are supported by measurement.

---

## 5. Risks and deferrals

| Risk | Mitigation |
|---|---|
| Prefix caching does not materialise | Phase 0 experiment; fallback is to absorb the cost with isolation intact — never a shared conversation |
| Coverage still partly model-dependent | Evidence records + runtime validation + independent verification of high-risk cells + the numeric false-clean rule |
| Contract drift | Canonical file, generated block, mandatory CI check |
| Adapter breaks on a CLI change | Recorded fixtures + release-gate compat command; failure → `INCONCLUSIVE` |
| Hostile custom instructions | Clamped at parse; hostile-input test |
| Runtime rots | 4 modules, no review logic in JS, deterministic CI from Phase 1 |

**Deferred to Phase 3 (none of it in the accepted MVP):** codex/OpenCode adapters, resume and review-after-fix comparison, graph closure, `/review --strategy`, corpus-wide evaluation, pass-count re-evaluation. **Never:** write capability to reviewed source or external systems.

**Open question, blocking Phase 3 only:** the evaluation corpus needs diffs with known defects; this plugin's own history is markdown-only, so it must come from an external repository. Which one?

---

## 6. ADR

**Decision.** Build `/loop-review` as a 4-module, dependency-free Node runtime inside the existing `consensus-review` plugin. The runtime owns state, context construction, budgets and the stopping rule; all review reasoning stays in prompt files. Contracts and CI ship first, then the MVP, preceded by a half-day technical spike that records adapter fixtures and settles the cache question.

**Drivers.** Enforceability of the `CLEAN` completion contract; cost structure dominated by repeated repository exploration; a maintenance surface in a repo that has never carried code.

**Alternatives considered.** Markdown/subagent orchestration — cannot enforce two accepted success criteria. `/consensus-review --mode loop` — fuses a second execution graph onto the most-edited region of the codebase. A separate plugin — no mechanism to share the contracts.

**Why chosen.** The feature's differentiator is a `CLEAN` verdict that is trustworthy. That is a control-flow guarantee, and only the runtime can make it.

**Consequences.** The plugin acquires its first code, tests and CI, and a versioned contract shared by two commands. `/consensus-review` is unchanged at runtime, but its inline schema becomes generated rather than hand-maintained. `claude -p` cache behaviour affects cost only, not the design: per §1.6, if prefix caching does not materialise the runtime keeps process isolation and absorbs the cost.

**Follow-ups.** Settle prefix caching in Phase 0; choose the Phase 3 evaluation corpus; revisit `/review --strategy` after measurement; revisit separate-plugin packaging only against the accepted draft's own review triggers.


---

## Implementation status

Implemented on `feat/loop-review`. 153 tests, zero dependencies. Phases 0, 1 and 2 are complete;
Phase 3 remains future work as planned.

### Deviations from this plan, and why

| Plan said | Shipped | Why |
|---|---|---|
| `--allowed-tools` hard-restricts a pass to the prebuilt context | `--disallowed-tools` does the restricting | Measured in Phase 0: `--allowed-tools` is permissive/additive and restricted nothing — a pass with `--allowed-tools ""` still read files. See `loop-review-measurements.md` §US-003. |
| Cross-process prompt caching may make repeated passes cheap | Not available; the cost is absorbed | Phase 0 refuted it: `cache_read` was identical across three separate processes while `cache_creation` recurred every run. The plan's own fallback applied — isolation kept, cost accepted. |
| A JSONL run log is written from Phase 2 | Run state is emitted on stdout via `--json`; no log file is written | Keeping the runtime to a single write (the report) makes the read-only guarantee simple to state and to test. Redirect `--json` if you want a record. This is a real reduction in scope, recorded here rather than quietly dropped. |
| Verification runs once, after the loop | Verification runs after each pass | Required to make the negative-space handoff work: a refutation is only useful to the *next* pass, and high-risk cells need a verdict before `CLEAN` is considered. Costs one extra call on diffs with findings. |
| Every pass re-affirms every cell | Coverage stands on the last valid record; omission is not retraction | Requiring re-affirmation fights the negative-space design, which exists to send later passes elsewhere. Implemented literally, it made two of three benign runs `INCONCLUSIVE` from ordinary terseness. A rejected or retracting record still withdraws coverage. |

### Known limitations

Recorded in `loop-review-measurements.md`. Both require a hand-crafted diff or instruction file and
cannot produce a false `CLEAN` from real runner output.
