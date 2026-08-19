<!-- STATUS: Phase 0 IMPLEMENTED on branch feat/evals. Phases 1-2 remain PENDING APPROVAL.
     Plan approved via /ralplan consensus (Planner -> Architect -> Critic x5). The user approved
     Phase 0 only; the paid corpus was deliberately not built. See "Implementation status" below. -->

# Eval layer — implementation plan (v7)

> **Phase 0 is implemented.** Phases 1 and 2 are unbuilt and still pending approval.

Target: `/home/andrii/opencode_sanbox/consensus-review`, new branch `feat/evals` off `main` @ `503780a` (v0.8.1).

**Problem.** The repo has 153 tests; none loads a prompt and none calls a model. Corrupting
`prompts/loop-review/discovery.md` leaves the suite green. The five agents in `agents/` have zero
coverage of any kind. Sixteen files — `agents/*.md`, `commands/*.md`, `prompts/loop-review/*.md`,
`contracts/{severity-bars,adapter}.md` — carry all the review behaviour and none of the protection.

History: v1 → Architect → v2 → Critic **ITERATE** → v3 → **ITERATE** → v4 → **ITERATE** → v5 →
**ITERATE** → v6 → **ITERATE** → **v7**. §11 records each step. Every code claim below was checked against the tree.

---

## 0. Findings that constrain the design

### 0.1 `claude plugin eval` is unavailable

Verified, CLI **2.1.234**: `claude plugin eval .`, `--json`, and `init --bare` all print
`` `plugin eval` is currently in early access `` and **exit 0** without doing anything. A CI job
shelling out to it would report success while running no evals.

### 0.2 Three payload shapes, one undocumented relationship

`contracts/finding.schema.json` is `/consensus-review`'s 11-field shape (incl. `dimension`,
`owner`). `/loop-review`'s discovery payload is a 9-field subset **plus** a `cells` array. The
verifier payload is a third, incompatible shape (`verdicts` + `cell_verdicts`).

### 0.3 Schema↔runtime is the boundary that decides acceptance, and it is unguarded

The runtime validator, not any document, decides what is accepted. Verified divergences:

| Direction | Divergence | Evidence |
|---|---|---|
| runtime accepts **more** | `line`, `failure_scenario`, `suggested_fix` accept numbers | `validateFinding` |
| runtime accepts **more** | extra finding properties ignored; schema says `additionalProperties: false` | `validateFinding` |
| runtime accepts **less** | `title`/`file`/`rationale` must be non-**blank** after trimming; schema allows `""` and `"   "` | `validateFinding` |
| runtime accepts **less** | P0/P1 require a non-blank `failure_scenario`; schema allows `null` | `validateFinding` |
| not expressible in JSON Schema | `validateEvidence` reads `cell.files` and `cell.maxLine` — **outside** the record | `validateEvidence` |
| structural only | the adapter rejects a missing `requireKey` array, **any non-object member**, and a missing `cells` on discovery | `adapter.interpret` |
| not expressible at all | a verifier id must be one **this verification batch** issued; evidence must be ≥20 chars and name the finding's file, basename or a matching suffix; a cell verdict must quote one of that cell's own validated anchors as a parsed location | `applyVerdicts`, `evidenceSubstantiates`, `runLoop` |

v4 declared only the first two. All seven are declared in §3.2 and asserted in §3.3, each at the
layer that can actually hold it.

---

## 1. RALPLAN-DR summary

### Principles

1. **Determinism decides what may block automatically.** A check returning the same answer for the
   same input may fail a build unattended; a stochastic one may only produce numbers a human reads.
   §7 is a human decision on a recorded measurement.
2. **Generate the derived copy; test the boundary you cannot generate.** Derived copies come from a
   machine-readable source and drift dies at regeneration. Where two implementations must agree —
   schema and runtime validator — a test asserts it, and every legitimate disagreement is
   *declared* rather than discovered later.
3. **Precision is half the signal, and absence of findings is not precision.** A run that inspected
   nothing must never read as a clean result.
4. **A measurement that cannot be attributed is not evidence.** Raw payloads and identifying
   metadata are retained, including for failures.
5. **Claim only what the instrument measures.** Four fixtures observe four end-to-end outcomes —
   neither a recall nor a precision metric.

### Decision drivers

1. **What actually breaks.** The one regression that shipped here was mechanical — the
   `findings`/`verdicts` key mismatch behind a false `CLEAN`. Calibration drift needs a model.
2. **The binding cost is quota, not money.** No `ANTHROPIC_API_KEY`, so `total_cost_usd` values the
   usage limit — hit once already. ~$0.20/pass × 2–4 passes/run makes repetition the expensive axis.
3. **Stochasticity is measured.** One seeded case flipped `FINDINGS`/`ESCALATE` ~50% on identical
   input until its cause was found.

### Decision 1 — gating policy

**A — deterministic checks block; the corpus reports. CHOSEN.** Honest weakness: calibration
regressions surface when someone runs the corpus, not at commit time.

**B — path-triggered PR gate.** Not blocked by §0.1 — the harness is ours. Deferred on one ground:
with no variance on record its threshold would be invented, and the observed ~50% flip means it
would fail on unrelated work. The intended successor.

**C — pre-commit.** Rejected **for the corpus**, adopted **for the deterministic layer**: a
stochastic gate on every commit trains `--no-verify`, and a bypassed gate sheds the signal while
keeping the friction. That argument does not reach a ~50 ms deterministic check, so it ships as an
opt-in hook (§3.5).

### Decision 2 — harness invokes the production CLI

`node bin/loop-review.mjs --repo <tmp> --json --no-file` against materialised fixtures (§5.1). This
exercises `resolveTarget`, the stale-diff resample and flag handling instead of bypassing them.

v3 proposed extracting `src/loop-review/runner.mjs` plus a characterisation parity test; v4 dropped
both, since with CLI invocation there is nothing to extract and no extraction risk to mitigate.
What CLI invocation costs is that the JSON projection hides run state — which is §4's subject, and
is fixed there rather than worked around.

### Decision 3 — the schema validator is local

The repo is deliberately dependency-free. §3.3 needs "the schema's verdict", so a **small local
validator** covering the JSON Schema subset actually used — `type`, `properties`, `enum`,
`required`, `additionalProperties`, `items`, `$defs`, `$ref`, union types — ships with its own tests. This is a
decision, not an implementer's dilemma: adding a validator dependency to a zero-dependency plugin
to test four schemas is the worse trade.

This stays small only because the schema is never asked to carry a semantic or contextual rule
(§3.3). No `minLength`, `pattern`, `if`/`then` or `allOf` support is required.

---

## 2. Scope

**In.** Phase 0 deterministic layer (CI). Phase 1 live corpus and recorded baseline (manual).
Phase 2 release-time review.

**Out, explicitly.** PR gating — deferred on §6 data. Ablation arms. `/consensus-review`'s parallel
orchestration. Behavioural agent evals (§5.7).

---

## 3. Phase 0 — deterministic layer (free, CI)

### 3.1 Two entrypoints, one generator

New canonical `contracts/loop-payload.schema.json` with **two entrypoints**, because the payloads
have incompatible top-level shapes (§0.2):

- `#/$defs/discoveryPayload` — `{findings: [loopFinding], cells: [evidenceRecord]}`
- `#/$defs/verifierPayload` — `{verdicts: [verdict], cell_verdicts: [cellVerdict]}`

`scripts/gen-contracts.mjs` gains a **sketch renderer** (JSON Schema → the
`{"title": str, "severity": "P0"|"P1"|"P2"}` form the prompts already use). Prototyped: it
reproduces `discovery.md`'s current block exactly, modulo §0.2's two fields. Both prompt templates
move inside `BEGIN GENERATED`/`END GENERATED` markers and render from their entrypoint, so
`gen-contracts --check` — already a CI job — covers prompt↔schema drift.

### 3.2 The declared exception sets

`#/$defs/loopFinding` is a projection of `finding.schema.json#/properties/findings/items` by
explicit JSON Pointer. Every difference must fall in one of three declared sets; anything else fails:

- **omissions** — `dimension`, `owner`
- **widenings** (loop accepts more) — `line`, `failure_scenario`, `suggested_fix` each add `number`;
  extra properties tolerated
- **narrowings** (loop accepts less) — `title`, `file`, `rationale` must be non-**blank** after
  trimming; `failure_scenario` must be non-blank when `severity ∈ {P0, P1}`

The narrowings are the P0/P1 evidence bar enforced in code, and v4 omitted them while relying on
them elsewhere. v5 wrote "non-empty", but `validateFinding` calls `.trim()`, so a whitespace-only
value is rejected too — hence "non-blank", with whitespace-only cases in §3.3's generated boundary
set.

**The narrowings are deliberately *not* encoded in the schema.** Expressing them would need
`minLength`, `pattern` and `if`/`then`, growing Decision 3's validator to carry rules that
§3.3 layer 2 asserts directly against `validateFinding` anyway. The schema states structure; the
table states semantics.

### 3.3 Three enforcement layers — schema for structure, tables for semantics

v4 described one test over two validators; v5 split it by payload. Both were still wrong in the
same way: they asked one schema to hold rules of three different kinds. What the runtime enforces is
partly *structural*, partly *semantic* (non-blank after trimming, a conditional evidence bar), and
partly *contextual* (an id must be one this verification batch issued; an anchor must match evidence
supplied on an earlier pass). JSON Schema **could** express the semantic rules with `minLength`,
`pattern` and conditionals — the plan declines to, so the validator stays small (Decision 3). It
**cannot** express the contextual ones at all, at any cost.

So the boundary is layered, and each layer is asserted where it can actually be checked. This is
also what keeps Decision 3's validator small: the schema is never asked to carry a semantic rule.

**(1) Structural — schema, checked by the local validator.** Types, enums, `required`,
`additionalProperties`, and array-member objecthood. This is the layer that is generated into the
prompts (§3.1). Enforced in production by `adapter.interpret`, which rejects a missing
`payload[requireKey]` array, **any non-object member of it**, and — for discovery only — a missing
`cells` array. v5 said the adapter "only checks the array", which was false.

**(2) Semantic on a single record — a declared table, asserted against the validators.** Records
generated at each boundary (field present/absent, each enum member, one value outside it, each type
in a union, empty **and whitespace-only** strings) go through both the local validator and
`validateFinding`. Because §3.2's omissions and widenings are already **encoded** in `loopFinding`,
the two must **agree** on those. The only permitted disagreement is the **narrowings**, which the
schema deliberately does not encode, and the disagreeing set must be exactly the narrowings. `validateEvidence` is asserted the same way but against a **canonical cell
fixture** (known `files`, known `maxLine`), because it reads `cell.files` and `cell.maxLine` from
outside the record: anchors inside the cell's files and within bound pass; a foreign file or an
out-of-bound line fails.

**(3) Contextual on a whole run — a declared table, asserted against a constructed run.** The
verifier boundary spans three sites with **three different consequences**, and v6's single table
flattened them wrongly. Verified against `adapter.interpret`, `runLoop` and `applyVerdicts`:

| Site | Rule | Consequence |
|---|---|---|
| `adapter.interpret` | `payload.verdicts` is not an array, or **any member is not a plain object** | pass state `malformed`; nothing is applied. v6 wrongly called this a silent skip |
| `runLoop` envelope | `verification.state` is present and not `ok` | `run.rejections` entry; **nothing** applied — a permanent `CLEAN` block, not a skip |
| `runLoop` envelope | `verdicts` or `cell_verdicts` present but not an array | same. Either key **absent** is legal and defaults to `[]` |
| `runLoop` id mapping | `v` is not an object, or `v.id` is not one of the short opaque ids `F1…Fn` **issued for this verification batch** | verdict silently dropped. `v.fingerprint` is **not** consulted here — v6 wrongly called the two interchangeable and the scope "this run" rather than this batch |
| `applyVerdicts` | a `confirmed`/`refuted` whose evidence is not grounded: not a string, under 20 chars after trimming, or no path-like token that equals the finding's `file`, equals its basename, **or is a matching path suffix** | verdict silently skipped → finding stays unadjudicated → `isUnresolvedActionable` escalates |
| `runLoop` cell verdicts | not an object; `cv.id`/`cv.cell` names no known cell; `cv.verified !== true` | silently skipped; cell stays unverified, blocking `CLEAN` |
| `runLoop` cell verdicts | `cv.reason` does not quote one of the cell's **own** anchors — compared as *parsed locations* with `path`, `line` and `lineEnd` all equal, and only anchors that themselves passed `validAnchor` are eligible | same. v6's "citing an anchor" was materially looser than the code |

The three consequences are the point, and they are why this cannot be a schema: a malformed
*response* fails the pass, a malformed *envelope* records a rejection that permanently bars `CLEAN`,
and a bad *individual* verdict is dropped in silence so that the finding it failed to adjudicate
escalates instead. That last path is the false-`CLEAN` hazard class the runtime was built to close,
so the table is asserted directly against these functions with a constructed run.

The schema documents the fuller verifier shape the prompt asks for; the gap between what the prompt
asks and what the runtime enforces is recorded here rather than asserted away.

### 3.4 `scripts/lint-prompts.mjs`

| # | Check | Method |
|---|---|---|
| L1 | `agents/*.md` frontmatter carries `name`, `description`, `model`; `name` equals the filename stem | parse frontmatter |
| L2 | every review agent still carries `disallowedTools: Write, Edit` | parse frontmatter |
| L5a | each agent's backticked vocabulary **contains** every severity **and every verdict** it is contracted to emit | presence — catches deletion |
| L5b | no backticked severity or verdict token **outside** `contracts/severity-bars.md`'s vocabulary | subset — catches addition |
| L6 | every agent named as a `subagent_type` in `commands/*.md` exists in `agents/`, and every agent is dispatched by some command | parse the declared dispatch form, not bare name occurrences |

**L2** is load-bearing: read-only is the plugin's headline promise, and a dropped line silently arms
five Opus agents with Write.

**L5a covers verdicts, not only severities.** v4's split left a hole: `finding-verifier` is
contracted to emit exactly three verdicts, and deleting every backticked `refuted` remained a valid
subset. L5a now requires the contracted verdicts of the agent that emits them.

**L5 is a heuristic and its promise is scoped to its method.** Prototyped both ways: bare-token
matching goes **red** on `agents/impact-reviewer.md:62`, where `P3` appears in the prose "(Original
P3 collapses here.)" — a false positive; backtick-scoped is green on the tree as it stands. The
cost is real: **drift written in bare prose is an acknowledged false negative.** `reduced` is in the
contract but is a normalized outcome the verifier never emits, so it is permitted and never
required. The deterministic layer is exact **except** L5.

### 3.5 Acceptance — both directions

*Must go red:* a frontmatter key removed; `disallowedTools` dropped; a contracted severity **or
verdict** deleted from a backticked vocabulary (L5a); a backticked severity or verdict outside the
contract (L5b); a `subagent_type` naming no agent; a prompt template out of sync with its
entrypoint; a shared field typed outside §3.2's sets; an undeclared schema↔runtime disagreement.

*Must stay green:* prose rewritten around an unchanged contract; an extra unrelated fenced block;
frontmatter in an equivalent syntax; a contract term appearing only in commentary (the `P3` case,
kept as a regression test); `reduced` present or absent.

Optional `.githooks/pre-commit` runs this layer only, opt-in via `git config core.hooksPath`.

---

## 4. Run health — computed in code, exposed in JSON

`evaluateTerminal` returns `FINDINGS` **before** reaching ordinary failure reasons — too few passes,
uncovered cells, budget exhaustion, rejections — and discards them when it does
(`src/loop-review/schema.mjs`). So a confirmed planted P0 can pass a broken run off as a recall
success, and a run that inspected nothing has no P0/P1 and would read as clean precision.

v4 defined the predicate but left it uncomputable: the CLI emits only
`{terminal, reasons, findings, cells, passes, spent}`, so `minPasses`, `rejections`, the configured
budget and staleness are simply absent, and `reasons` cannot substitute because `FINDINGS`
discards them.

**Fix, in two parts.** `evaluateHealth(run, currentDiffHash)` joins `schema.mjs` and returns
`{ok, failures[]}` over: every pass `ok`; `passes.length >= minPasses`; zero uncovered cells; every
mandatory cell independently verified; `rejections` empty; budget not exhausted; not stale. And
`--json` emits `health` **plus its raw inputs** — `minPasses`, `maxPasses`, `rejections`,
`escalations`, `budget`, `stale` — so a grader can both trust one verdict and attribute it. Health
lives in code for the same reason the `CLEAN` conjunction does: one definition, not one per consumer.

**Terminal state is recorded, never asserted.** A case failing health is **neither a pass nor a
fail** of what it measures — it is a **void** run, reported as such and excluded from the rate.

---

## 5. Phase 1 — live corpus

### 5.1 Fixtures

A fixture is a checked-in **pre-change file tree plus a diff**. The harness materialises a **fresh**
temp git repo per run — `git init`, commit the pre-state, apply the diff, leave it uncommitted — so
the default mode diffs against `HEAD` and `buildContext` loads original file content.

v2 proposed diffs with `base: null` and called it "no git". Both halves were wrong: with
`base: null`, `originals` is `{}` (`context.mjs`), so no pre-change content reaches the prompt, and
`isGenerated` shells out to `git check-attr` regardless.

### 5.2 Invoking the CLI — three details that matter

- **`--no-file` is mandatory.** By default the CLI writes `.reviews/loop-review-<hash>.md` into the
  repo; in a reused fixture repo that untracked report would enter the *next* run's diff via
  `resolveTarget`'s untracked-file handling. Fresh materialisation per run (§5.1) is the belt;
  `--no-file` is the braces.
- **`ESCALATE` exits 2** while still printing usable JSON. The harness parses stdout regardless of
  exit status, and treats only a non-zero exit with unparseable stdout as a harness failure.
- **The resolved model is available, but not where v4 said.** `adapter.run()` returns
  `modelId: model` — the *requested alias*. The CLI envelope carries the real one:
  `modelUsage["claude-sonnet-5"].canonicalModel` (verified in `test/fixtures/adapter/ok.json`). The
  adapter is extended to surface it, falling back to the alias marked `unresolved` when the
  envelope omits it.

### 5.3 Raw payload capture

`runLoop` consumes `result.payload` and retains only pass metadata, so no raw payload reaches a
grader. `bin/loop-review.mjs` gains `--dump-passes <dir>`, hooked **inside `adapter.run()`** — the
single place every response passes through, discovery and verifier alike — rather than at the two
call sites in `bin/`, where one would eventually be forgotten.

Each record captures `stdout`, **`stderr`**, `rc`, `signal` and `timedOut`, annotated after
interpretation with `state`, `usage` and a call index. `stderr` matters because it is never carried
into the result today, and on a non-zero exit it may hold the only explanation. It is not a
guarantee — the captured timeout fixture has an empty `stderr` — so it is captured because it
*can* carry the explanation for exactly the cases attribution needs, not because it always does. Verifier calls currently receive no pass index; the dump assigns one.

This is a debugging affordance for real runs. With `--dump-passes` and the `--json` additions of §4,
these are the only production changes the plan makes.

### 5.4 Corpus

| id | kind | fixture | required | recorded |
|---|---|---|---|---|
| `auth-guard-removed` | recall | ownership check deleted from a handler | health; a reportable P0 in the planted file, anchored in the planted range, category `security` | terminal, P2 count |
| `destructive-migration` | recall | irreversible column drop, no rollback | health; a reportable P0 in the migration, anchored in the planted range, category `data` or `correctness` | terminal, P2 count |
| `pure-refactor` | precision | behaviour-preserving extraction | health; zero P0, zero P1 | terminal, P2 count |
| `cosmetic-only` | precision | a stylistic wart and nothing else | health; zero P0, zero P1 | terminal, P2 count, whether each P2 carries a project anchor |

File + line range + category still does **not** establish that the finding *is* the planted defect —
a different P0 of the same category on the same lines would pass, and semantic identity is not
mechanically decidable. The raw payload is retained and spot-checked by a human once, when the
baseline is set, and that judgement is recorded rather than re-litigated per run.

### 5.5 Graders

Over dumped raw payloads: each discovery payload validates against `#/$defs/discoveryPayload`, each
verifier payload against `#/$defs/verifierPayload`. Not against `finding.schema.json`, and not
against the enriched runtime finding, which carries `fingerprint`, `verdict` and `foundInPass` that
an `additionalProperties: false` schema rejects.

Over `--json`: `health.ok` (§4); every P0/P1 carries a non-null `failure_scenario`; no finding names
a file absent from the diff; then §5.4's per-case requirements.

Graders get unit tests over constructed run objects and payloads — a grader that cannot fail is not
a grader — under §3.5's mutation/benign discipline.

Exactly one property is genuine judgement: whether a `failure_scenario` is a concrete
input-to-harm path rather than a generic "could break". No judge is available (§0.1), so it is
recorded for human reading and never mixed into the deterministic result.

### 5.6 Cost control

A **total** sweep budget, not only the per-run one `runLoop` enforces, with incremental writes so
an exhausted quota leaves partial data rather than nothing.

### 5.7 Agents — an accepted scope gap, not an impossibility

The five agents are dispatched as Claude Code subagents, which this harness does not reproduce
faithfully; they get Phase 0 coverage only. v3 said this waits "until `plugin eval` opens", which
overstated the evidence: a **low-fidelity smoke check is possible today** — run an agent's prompt
body through the same adapter and grade the payload shape — it simply measures the prompt in
isolation rather than the agent as dispatched. Deferred **by choice of scope**. This remains the
largest accepted gap: half the behaviour-bearing files get structural but no behavioural protection.

---

## 6. The deliverable is a table of numbers

`docs/eval-baseline.md` records, per case: successes `k` of `n`, void runs, P2 counts, wall-clock,
quota draw. Plus what makes a number attributable — git SHA, hashes of every prompt and fixture,
CLI version, the **canonical model id** from §5.2, flags, timeouts, budgets — and §5.3's retained
payloads. **No threshold is set in this phase.**

---

## 7. Phase 2 — release-time review

The corpus joins `compat-check` in `docs/RELEASING.md`. The precedent transfers but **not
verbatim**: `compat-check` guards CLI-upgrade failures, which land at release boundaries, whereas a
calibration regression lands on the commit that edits the prompt. Release-time placement is
pragmatic pending option B, not the same argument.

**Batch size is fixed at `n = 5`.** It is recorded with every baseline, and changing it invalidates
the baseline rather than rescaling it.

**Statistics, named.** Clopper–Pearson **one-sided 95%** lower bound. For `k = n = 5`:
`0.05^(1/5) = 0.5493`, and `P(0 of 5) = (1 − 0.5493)^5 = 0.0186`; two independent batches
`≈ 0.00035`. v3 paired the two-sided bound (0.4782 → 0.0387) with the one-sided probability and
claimed "≲0.03" — wrong, and "outside variance by any reading" is withdrawn.

**Eligibility.**

- **Stable** iff baseline `k ∈ {0, n}` over a complete batch of `n`. Anything else is **unstable**:
  recorded, excluded, never accommodated with a lower bar.
- **Stable-zero** (never passes) is **ineligible** and does not count toward quorum — it is a broken
  case or a broken grader, filed as work, not read as a signal.
- Fewer than `n` completed baseline runs ⇒ **ineligible**.
- A release batch that is void under §4, malformed, timed out or quota-truncated is **not a
  result**: the case is ineligible **for this release**. v4 let an invalid *first* batch fall into
  "report everything else", contradicting §4's exclusion of void runs.

**Outcome, with precedence — `BLOCK` > `INCONCLUSIVE` > `REPORT`.** Evaluated in that order, so the
rule is total:

1. **BLOCK** — an eligible case whose baseline was `k = n` scores `k = 0` over a complete batch of
   `n`, confirmed by a second complete batch also scoring `0`. One zero batch reports; two block.
   A confirmed collapse is complete evidence of regression and outranks missing information
   elsewhere.
2. **INCONCLUSIVE** — no collapse confirmed, and either fewer than **two recall and one precision**
   eligible cases remain, or a confirmation batch was itself void. Release then requires an explicit
   override with the reason written into the compatibility table.
3. **REPORT** — everything else, including `n/n → (n−1)/n`. That is inside the noise this instrument
   resolves; blocking on it would reproduce the flake §1 exists to avoid.

Each release records its numbers beside the CLI version, as `compat-check` already does.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Four synthetic fixtures overfit | Stated in §5.4. Growth has a **trigger**: every P0 the plugin reports on a real repo and a human confirms becomes a candidate fixture at the next release review |
| L5 misses drift in bare prose | Acknowledged false negative (§3.4), scoped in the promise rather than hidden; L5a/L5b cover deletion and addition within the method's reach |
| Schema and runtime drift apart | §3.3, split by domain so each half is actually constructible |
| The local validator is itself wrong | It covers a deliberately small subset and ships with its own tests; a wrong validator fails §3.3's known-disagreement assertions rather than passing silently |
| Quota exhaustion mid-sweep | Sweep-level budget, incremental writes, resumable (§5.6) |
| A red run is uninterpretable | Raw payloads including `stderr` and failures (§5.3), canonical model id and content hashes (§6), two-batch confirmation (§7) |
| `--dump-passes` writes model output to disk | Off unless asked; only under a caller-named directory; documented as a debugging flag |
| `plugin eval` opens and this work is redundant | The deterministic layer is framework-independent. Whether fixtures and graders port is a **tentative assumption, not a design benefit** — the format is unverified (§9) |

---

## 9. What this plan does not know

The `claude plugin eval` reference gathered for a future migration is self-caveated: newer case
keys, grader score combination, `--json` field names and per-run sandbox semantics could not be
verified against a primary source, because the gate blocks the CLI that would confirm them. Nothing
in Phases 0–2 depends on it; the migration follow-up should re-derive the format when the gate opens.

---

## 10. Residual items, by the critic's own split

**Settle during implementation, not before:** how raw captures are annotated after interpretation
and how verifier calls receive their index; parsing JSON despite exit 2; extracting the canonical
model with a defined fallback; the exact planted-range overlap mechanics and renamed-path handling;
the storage layout for retained artefacts.

Four review rounds closed every item raised. The two that survived to round 4 — the verifier
enforcement boundary and the non-blank/conditional representation — were the same mistake twice:
asking a schema to hold a rule that is not structural. §3.3's layering is the fix, and it makes the
plan smaller rather than larger.

---

## 11. Revision history

**v2 → v3** (critic 1). Prompt templates are pseudo-JSON that `JSON.parse` rejects — parsing
replaced by generation. Validation aimed at the wrong contract (§0.2). "Stochastic checks may only
report" was contradicted by a release-blocking gate — narrowed to "may not block automatically".
Option B's rejection was overbroad. Pre-commit rejected wholesale when the argument only reached the
corpus. Diff-only fixtures starve the reviewer of context and "no git" was false. Precision fixtures
cannot be pinned to `CLEAN`. Thresholds came from an "observed spread" five binary runs cannot give.

**v3 → v4** (critic 2). Generation guards prompt↔schema and leaves schema↔runtime open (§0.3). One
loop schema could not cover incompatible payload shapes → two entrypoints. Graders read a raw
payload `runLoop` discards → capture at the adapter. Extraction plus parity test unnecessary once
fixtures are real repos → CLI invocation. Terminal asserted as an oracle though `evaluateTerminal`
returns `FINDINGS` before ordinary failures → run-health predicate. Recall = "a P0 in the planted
file" passes for the wrong defect → line range and category. L5's subset test left deletion green.
"≈0.48 … ≲0.03" mixed two confidence constructions.

**v4 → v5** (critic 3: B2 closed; B1, B3 partial; B4 open — plus two defects found in v4 while that
review ran):

| v4 | Why it failed | v5 |
|---|---|---|
| Two declared exception sets | Four more verified divergences existed, including the P0/P1 bar the plan relied on elsewhere | Three sets: omissions, widenings, **narrowings** (§3.2) |
| One conformance test over two validators | The three payloads have different domains; the anchor rule reads data outside the record, which JSON Schema cannot express; verifier envelopes have no runtime validator at all | Split by domain (a) findings (b) evidence, against a canonical cell fixture (c) verifier, scoped to what the adapter enforces (§3.3) |
| "the schema's verdict" | No JSON Schema validator exists, and the repo is dependency-free | Local subset validator as an explicit decision (Decision 3) |
| Run-health predicate | `minPasses`, `rejections`, budget and staleness are absent from `--json`, and `FINDINGS` discards `reasons` | `evaluateHealth` in code; `--json` emits `health` plus its raw inputs (§4) |
| `--json` command as given | Omitted `--no-file`; the default `.reviews/` write would enter the next run's diff | `--no-file` mandatory plus fresh materialisation per run (§5.2, §5.1) |
| Exit code unaddressed | `ESCALATE` exits 2 while printing usable JSON | Parse stdout regardless of exit status (§5.2) |
| "resolved model id" | `adapter.run()` returns the requested alias | `modelUsage[*].canonicalModel`, verified present in the captured envelope, with a marked fallback (§5.2) |
| Dump captures the response | `stderr` is never carried into the result, yet holds the only explanation on timeout and non-zero exit | Capture `stdout`, `stderr`, `rc`, `signal`, `timedOut`, hooked inside `adapter.run()` (§5.3) |
| L5a required severities | Deleting every backticked `refuted` stayed a valid subset | L5a requires contracted **verdicts** too (§3.4) |
| §7's rule | Not total: no precedence among outcomes, an invalid first batch fell into "report", `n` unfixed | `n = 5` fixed; `BLOCK` > `INCONCLUSIVE` > `REPORT`; invalid batch ⇒ ineligible (§7) |

---

### v5 → v6 (critic 4: M2–M5 closed, M1 open)

| v5 | Why it failed | v6 |
|---|---|---|
| "the adapter only checks that `verdicts` is an array" | It also rejects any non-object member, and requires `cells` on discovery | Corrected, and made layer 1 of §3.3 |
| Verifier conformance scoped to the adapter | Enforcement continues into `applyVerdicts`/`evidenceSubstantiates`: ids must name findings issued this run, evidence must be ≥20 chars and name the finding's file, cell verdicts need `verified: true` and a cited anchor — and every failure is a **silent skip** that escalates | §3.3 layer 3: a declared table asserted against a constructed run |
| Narrowings "non-empty", boundary set generates empty strings | `validateFinding` calls `.trim()`, so whitespace-only is rejected too | "non-blank after trimming", with whitespace-only boundary cases |
| Narrowings implied in the schema | Would need `minLength`/`pattern`/`if`-`then`, contradicting Decision 3's small validator | Narrowings explicitly **not** in the schema; asserted against `validateFinding` |
| "`stderr` holds the only explanation on timeout" | The captured timeout fixture has empty `stderr` | Softened to "may hold"; capturing it is still correct |

### v6 → v7 (critic 5: layering sound, layer-3 table factually wrong)

| v6 | Why it failed | v7 |
|---|---|---|
| One layer-3 table, "every failure is a silent skip" | Three sites with three different consequences: the adapter fails the pass, a malformed envelope records a permanent `CLEAN`-blocking rejection, only per-item failures are silent | Table split by site, each with its consequence |
| `v.id` and `v.fingerprint` interchangeable, scope "this run" | `runLoop` filters on `idMap` before `applyVerdicts`; only the opaque `F1…Fn` of **this batch** resolve, and `fingerprint` is never consulted there | Corrected |
| Cell verdict "cites an anchor" | Requires an exact parsed match on `path`, `line` **and** `lineEnd`, against only anchors that passed `validAnchor` | Corrected |
| Evidence grounding = token equals path or basename | `evidenceSubstantiates` also accepts a matching path **suffix** | Corrected |
| "No schema can state either" | False for the semantic rules — JSON Schema could, we decline | Split: semantic = declined, contextual = impossible |
| Layer 2 disagrees on all §3.2 sets | Omissions and widenings are encoded in `loopFinding`, so they must **agree**; only narrowings may differ | Corrected |
| Validator subset list | Omitted `properties`, which every object schema needs | Added |

---

## 12. ADR

**Decision.** Cut the eval layer on the determinism seam. Generated contracts, a domain-split
schema↔runtime conformance test, and a parsing lint block every push. A live corpus invokes the
production CLI against freshly materialised fixtures and produces numbers. A release-time review
reads them under a total, explicitly-derived rule.

**Drivers.** `claude plugin eval` is gated and unusable; observed ~50% flake on a seeded case;
quota as the binding constraint; and the fact that the one regression that shipped here was a
mechanical contract break, not calibration drift.

**Alternatives considered.** PR gate — deferred on variance data alone, named the successor.
Pre-commit — split: rejected for the corpus, adopted opt-in for the deterministic layer. Framework
harness — unavailable. In-process harness with an extracted runner — superseded by CLI invocation.
Diff-only fixtures — rejected on verified evidence they starve the reviewer of production context.
A JSON Schema dependency — rejected against the repo's zero-dependency design.

**Consequences.** Every push gains protection against contract, schema/runtime and read-only
regressions at zero cost. Calibration regressions surface at release rather than at commit. Two
production changes are added: `--dump-passes` and the `--json` health fields. The five agents get
structural but not behavioural coverage — the largest accepted gap.

**Follow-ups.** Promote the corpus to a non-blocking path-triggered PR report once §6 produces
variance. Re-derive the `plugin eval` format and add behavioural agent cases when the gate opens.
Reconcile `package.json` version `0.7.0` against `plugin.json` `0.8.1` — unrelated, surfaced
because L1 touches manifest consistency.

---

## 13. Implementation status — Phase 0

Built on `feat/evals`. **245 tests pass** (153 pre-existing, 92 new). The deterministic layer runs in
**~53 ms**, which is what makes the opt-in pre-commit hook defensible.

| Delivered | File |
|---|---|
| The loop payload contract, two entrypoints, declared projection and runtime deltas | `contracts/loop-payload.schema.json` |
| Local JSON Schema validator over the subset actually used | `scripts/lib/json-schema.mjs` |
| Schema → type-sketch renderer | `scripts/lib/sketch.mjs` |
| Generator extended to 3 targets + the projection check | `scripts/gen-contracts.mjs` |
| Prompt templates now generated | `prompts/loop-review/{discovery,verify}.md` |
| The lint | `scripts/lint-prompts.mjs` |
| Tests | `test/unit/{json-schema,conformance,lint-prompts,gen-contracts}.test.mjs` |
| Opt-in hook | `.githooks/pre-commit` |
| CI step | `.github/workflows/ci.yml` |

### Verified, not asserted

- **`prompts/loop-review/discovery.md` is byte-identical** after generation. The generator reproduces
  what the prompt already said, so adopting it changed nothing about what the model is asked for.
  `verify.md` changed only in line wrapping; its keys, types and enums are identical. Both are
  asserted by `gen-contracts.test.mjs`.
- **The regression that shipped a false `CLEAN` is caught.** Reintroducing it — hardcoding the
  adapter's payload key back to `findings` — turns the suite red. Honest caveat: a pre-existing test
  fires too, so the new layer-1 check is additional coverage rather than the sole guard.
- **`commands/consensus-review.md` is untouched**, so `/consensus-review`'s runtime behaviour is
  unchanged.

### Deviations from the plan, and why

| Planned | Actual | Why |
|---|---|---|
| L5b covers severities **and** verdicts | L5b covers severities only; new **L5c** covers verdicts | L5b's verdict half was **vacuous**: the pattern that finds verdicts *is* the contract list, so an invented word like `maybe` cannot match it. L5c instead parses the closed alternation out of the verifier's own output template and compares it for equality, which reaches both directions. Found by a mutation test that failed to go red |
| `x-runtime` numeric tolerance applies to `failure_scenario` generally | Reachable only at **P2** | At P0/P1 the actionable bar demands a non-blank *string*, so a number is rejected there for that reason instead. Recorded in the schema |
| L5a requires severities of every agent | Unchanged, but the extractor had to tokenise *within* backtick spans | The verifier declares its severities inside one backticked JSON template, `"suggested_severity": "P0\|P1\|P2\|null"`. Whole-span matching missed those — which would also have let an invented severity hide inside a template, the exact case L5b exists for |
| L6 requires `subagent_type:` in both directions | Forward strict, **reverse loose** | `commands/consensus-review.md` spawns `finding-verifier` by backticked name via Task, never `subagent_type:`. The strict form reported a live agent as orphaned. The forward direction still guards precision; a false "it is referenced" is far cheaper than a false alarm |
| — | `package.json` version reconciled `0.7.0` → `0.8.1` | The plan's own follow-up; it was inconsistent with `plugin.json` |

### Known limits, stated plainly

- **L5 cannot see drift written in bare prose.** Scoping to backtick spans is what stops it flagging
  `agents/impact-reviewer.md:62`'s "(Original P3 collapses here.)", and that trade is a false
  negative, kept as a green regression test.
- **No behavioural coverage of the five agents.** Phase 0 protects their structure and vocabulary
  only. Unchanged from the plan, and still the largest accepted gap.
- **The local validator announces its own limits**: it throws on any keyword it does not implement,
  so adding `minLength` to a contract fails loudly instead of looking enforced.
