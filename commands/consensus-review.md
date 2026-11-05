---
description: Consensus code review (Opus arbiter + a consultant — codex, else pi, else claude-cli — optional `extra=pi`) across 4 dimensions (architecture/quality/impact/tests) for a PR or uncommitted changes; P0–P2 findings; strict sceptic by default; every flag also accepted with a leading --
argument-hint: "[<PR-url|owner/repo#N|#N>] [deep|minimal] [dims=<list>] [sceptic=off|basic|strict] [lang=<language>] [no-file] [<key>=<value>…]"
---

You are the **Opus arbiter** of a consensus review. Review runs by **dimensions** (what
to check) using **independent** reviewers (who checks): your dimension agents + one consultant
(`codex`, else `pi` ([pi.dev](https://pi.dev)), else `claude-cli`), plus the optional extra advisor `pi` with `extra=pi`.
Merge everything into a single consensus report with P0–P2 findings.
This is a **read-only** review: do not fix, commit, push, or comment on the PR.
The only writes are the markdown report file and its private run archive — and none at all with `out=none` (`no-file`).

Arguments: `$ARGUMENTS`

## 0. Resolve the settings

Work dir **outside the repo**: `WD=$(mktemp -d)` (in `/tmp`, not under the repo — otherwise it pollutes `git status`). Right after it, print `work dir: <WD>` (a dead run is salvaged from it with `archive-run.mjs finish --wd '<WD>'`) and record the invoking directory as `INVOKE=<abs path of the cwd>`. Shell state does not persist between calls, so keep `WD` and `INVOKE` as **literals** from here on; a later `cd` must move neither.

Write `$ARGUMENTS` **verbatim** (no paraphrase, no reordering, no quoting) with the Write tool to `$WD/args.txt`, then resolve it in **one** foreground call:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs" resolve --wd '<literal WD>' --args-file '<literal WD>/args.txt'
```
Exit 2 → print its stderr message and **stop**: a known setting with a bad value never falls back to a default. Exit 0 → read `$WD/settings.json` and use **only** its values from here on — `target`, `settings.<key>.value`, `ignored`, and the two report lines `lines.settings` / `lines.ignored` (§9). Never re-derive a setting from `$ARGUMENTS`; unknown and overridden tokens are already in `ignored`.

**Quoting rule:** every value from `settings.json` or a path you paste into a Bash command — the target `ref`, `owner/repo`, `N`, `pi-model`, `consultant`, a lane's `model` and `skipReason`, and every path (`WD`, `INVOKE`, `REPO`, the report path) — goes in **single quotes** (`'<value>'`), as in every command line below; never unquoted, never in double quotes. A value containing `'` is written with the `'\''` escape (`'it'\''s'`). Only a shell variable already set from such a literal (`"$WD"`, `"$REPO"`) stays in double quotes.

What each setting means (`settings.<key>.value`):
- `target` — `kind: "pr"` (a PR URL / `owner/repo#N` / `#N` in `ref`) → **PR mode**; `kind: "uncommitted"` → **uncommitted mode**.
- `depth` — `deep` forces the maximum tier (full panel + every enabled consultant), `minimal` the minimal tier, both skipping auto-classification; `auto` → §3 classifies. `deep` does **not** imply `extra=pi` — combine them if you want pi too.
- `dims` — the lanes, applied after triage (§3.5): `tier` → what the tier picks; `{"set": [...]}` replaces the set; `{"add": [...], "remove": [...]}` adjusts it. Names: `architecture`, `quality`, `impact`, `tests`. A set that ends up with zero lanes is an error: say so and stop, rather than running a review with no reviewers. `dims=+tests` is the only way to get a test review when the diff itself contains no test files — the case where a change is covered by an existing suite it affects only indirectly.
- `sceptic` — **ON and STRICT by default.**
  - `strict` (default) — the independent verifier **plus** the consultants re-run as refuters, with a majority vote per finding (§8).
  - `basic` — the independent verifier only: no refuter re-runs; `decide` still applies the vote rules to the verifier alone.
  - `off` — no sceptic pass at all.
  The pass only fires when there are P0/P1 findings, so trivial/clean reviews pay nothing at any setting. Strict costs one extra run per voting consultant on the reviews that do have P0/P1. Each vote is `AGREE`, `DISAGREE_EVIDENCE` (with a verified verbatim quote) or `DISAGREE_CONCERN`; a concern alone never refutes a finding nor removes one the verifier grounded. The four vote rules and their outcomes table are in §8: the verifier's `AGREE` confirms unless a checked refutation ties or outvotes it, its verified `DISAGREE_EVIDENCE` refutes unless an `AGREE` ties or outvotes it, a lone refuter can neither confirm nor refute, and with three voters (codex plus pi on an independent family as extra) 2 of 3 matching votes decide.
  **One refuter per model family** (intended change): a consultant of the panel's family (claude-cli, or pi on a Claude model), a second lane of a family that already votes (pi on OpenAI next to codex), or an `unknown` family gets no refuter. codex plus pi on OpenAI used to run two refuters; it now runs one.
- `consultant` — **one consultant, detected.** `auto` → the first installed of `codex` → `pi` → `claude-cli` (a nested read-only `claude -p`, model `sonnet`). `codex|pi|claude-cli` forces one; a forced consultant that is missing is reported `unavailable`, never replaced. §2 resolves all of this in code — do not re-derive it.
- `extra` — `pi` → also run `pi` as an extra consultant, unless pi already is the consultant (then there is still one pi lane, reported `skipped (pi is the consultant)`); `off` → no extra lane.
- `pi-model` — a model id (e.g. `pi-model=gemini-2.5-pro`, `pi-model=sonnet:high`) → passed to `pi --model` for whichever pi lane runs, consultant or extra. `auto` → §2 picks pi's model by role from `pi --list-models`: as the consultant an OpenAI model first, then glm → qwen → kimi; as extra glm → qwen → kimi. It never falls back to pi's unpinned default.
  - **Independence check:** the value of an extra consultant is a *different* model family. Read `extraSameEngine` from `review.decision.json` (§6); when it is true, the extra lane adds little — say so in the report (section 9) and suggest `pi-model=<other-model>`.
- `timeout` — per-attempt wall clock (`T`, integer seconds, already clamped) for the consultant lanes and their refuter re-runs. A lane that times out or fails transiently is **retried once**; a config error (bad auth, rejected schema, unknown model) is not. Each phase is bounded by **2×T** — §5 and §8 separately, so `sceptic=strict` can take up to ~4×T in the worst case. A lane whose attempts all fail is reported `degraded (…)` and **its findings are lost**, so the cost of setting this too low is a whole source silently dropped from the review, not a slower review. The lanes run in parallel, so a higher ceiling costs nothing until something actually hangs. Measured: a codex consultant reading a small repository was still working at **600s**, so the old `240` default truncated ordinary runs.
- `out` — where the report file goes. `default` → `<INVOKE>/.reviews/review-<slug>-<YYYY-MM-DD>.md`. A path ending in `/`, or naming an existing directory, is a directory and the default filename is used inside it; anything else is the exact file path. `none` (`no-file`) → terminal output only: the review performs **zero** writes anywhere on disk (`$WD` under `/tmp` aside) — no run archive either.
- `archive` — `on` (default): §9 copies a bounded, private snapshot of `$WD` (diff, each source's prompt and raw output, an event log) to `<INVOKE>/.reviews/<run-id>/`, and only when git confirms `.reviews/` is ignored. `archive=off` → no run archive. `out` moves the report, never the archive.
- `lang` — output language for the review, a code or a name. Code identifiers, paths, and technical terms always stay in their original form. Pass the chosen language to the dimension agents and into the consultant brief.

## 1. Resolve diff and context
`WD` and `INVOKE` come from §0, as literals.

**PR mode:**
- gh repo resolution: a full URL is self-describing. For `owner/repo#N` and `#N` pass `-R '<owner/repo>'` (otherwise `gh pr diff` from a non-git dir fails with "not a git repository"). Bare `#N` without owner/repo: try to derive the repo from the cwd git remote, else stop and ask for `owner/repo#N` or a URL.
- `gh pr view '<target>' [-R '<owner/repo>'] --json title,baseRefName,headRefName,headRefOid,url` (metadata only, **no** `body`).
- `gh pr diff '<target>' [-R '<owner/repo>'] > "$WD/diff.patch"`
- `gh pr view '<target>' [-R '<owner/repo>'] --json headRefOid` again. `HEAD_SHA` = that `headRefOid` if it equals the first one; if they differ, the PR moved under the diff and `HEAD_SHA` is **empty**.
- `REPO` = the current clone if it matches the PR; otherwise **diff-only mode** (note it in the report).
- **If `gh` is unavailable/unauthenticated** (first parse `owner/repo` + `N` from the URL or `owner/repo#N`):
  1. If a local clone of that repo exists: `git fetch '<remote>' 'pull/<N>/head'` then `git diff <baseRef>...FETCH_HEAD > "$WD/diff.patch"` and `HEAD_SHA=$(git rev-parse FETCH_HEAD)`. Never `git checkout` the PR in the user's clone.
  2. Else, for a public repository, fetch the diff over HTTP: `curl -fsSL 'https://github.com/<owner>/<repo>/pull/<N>.diff' > "$WD/diff.patch"`. This path is **diff-only** — note it. Never read a token from the environment to reach a private repository: that is what `gh` and a local clone are for.
  3. If none works (a private repository without `gh` or a clone, bare `#N` with no remote, or no network) → stop and report that PR mode needs `gh` or a local clone.

**Uncommitted mode:**
- `git diff HEAD > "$WD/diff.patch"`; untracked via `git status --porcelain`.
- Empty and no untracked → print "No changes to review" and **stop**.
- `REPO` = the root of the current repository. `HEAD_SHA=worktree`.

**`HEAD_SHA`** (keep it as a literal) tells the sceptic `decide` (§8) where a quote from a file outside the diff may be read: `--repo "$REPO" --head-sha <HEAD_SHA>`. Diff-only mode has no `REPO` and no `HEAD_SHA`: pass neither, so only the diff is checked. An empty `HEAD_SHA` means pass no `--head-sha`.

## 2. Pre-flight health-check
Select the consultants in **one** foreground call:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/run-lane.mjs" select --wd '<literal WD>' [--consultant '<x>'] [--extra] [--pi-model '<m>']
```
`--consultant '<consultant>'` when `consultant` is not `auto`, `--extra` when `extra` is `pi`, `--pi-model '<pi-model>'` when `pi-model` is not `auto` (values from `settings.json`). It writes `$WD/consultants.json`: `{"lanes":[{"name","brief","refuterBrief","model","skip","skipReason"}],"extraNote","reason"}`. Read it; §4, §5 and §8 copy its values **literally**. A lane with `skip` is not started (don't wait for the timeout); it keeps its line with `--skip`. With `extra=off` there is no extra lane.

**Code graph (if the review runs in the project dir).** Check for a prebuilt code graph: `.codegraph/codegraph.db` (codegraph) or `graphify-out/graph.json` (graphify). If present — set `CODE_GRAPH=codegraph|graphify` and use it downstream (triage blast-radius + consultant brief + the dimension agents pick it up themselves). **Detect-and-use only; do NOT build the graph** (building graphify costs tokens). No graph → plain grep, that's fine.

## 3. Triage: classify the change (BEFORE running reviewers)
Goal — don't run the whole panel where it isn't warranted (e.g. a 2000-line PR of hand-added Bruno configs has zero code impact). Size alone is not the signal — what matters is "effective code" and blast radius.

**3.1. Split changed files into classes** (`git diff --numstat` / `gh pr diff` + names; account for added/renamed/deleted):
- **non-code (zero/low impact)** — Bruno/Postman/HTTP (`*.bru`, `*.http`, `*.rest`, postman collections); lock files (`*-lock.json`, `*.lock`, `pnpm-lock.yaml`, `yarn.lock`, `go.sum`, `Cargo.lock`, `poetry.lock`, `composer.lock`); docs (`*.md`, `*.mdx`, `*.rst`, `docs/**`, `LICENSE`); assets (images, fonts, `*.svg`); data/fixtures (`*.csv`, `__snapshots__/`, `*.snap`, fixtures/); generated (`dist/`, `build/`, `*.min.*`, `*.generated.*`, `*.pb.go`); i18n (`locales/**`, `*.po`).
- **config-as-code (medium impact — runtime/deploy)** — config `*.json|*.yaml|*.toml`, `Dockerfile`, CI (`.github/workflows/**`), IaC (`*.tf`), env templates.
- **dependency manifests (impact + security)** — `package.json`, `go.mod`, `Cargo.toml`, `requirements.txt`, `pyproject.toml`, `pom.xml`, `build.gradle`.
- **migrations (high impact)** — `migrations/**`, `*.sql`.
- **tests** — path patterns `*test*`, `*spec*`, `__tests__/`, `*.test.*`, `*.spec.*`, `*_test.go`, `test_*.py`, `*Test.*`.
- **source code** — the remaining executable code.

**3.2. Effective code size** — lines/files ONLY in the source/config-as-code/manifests/migrations/tests classes (exclude non-code from the size, but remember it for the report):
`none` (0 code) / `small` (≲50 lines or ≲3 files) / `medium` (≲~400 lines or ≲~15 files) / `large` (more).

**3.3. Blast radius** — how much the change affects the rest of the code:
- `wide` — touches dependency manifests, migrations, auth/permissions/security paths, public/exported API, shared/common/core/lib/packages modules, OR the changed modules have high fan-in. Estimate fan-in via the code graph when `CODE_GRAPH` is set: `codegraph impact <symbol>` / `codegraph callers <symbol>` or `graphify explain "<Symbol>"` / `graphify path`; otherwise `grep -r` over imports (fallback).
- `isolated` — a new self-contained leaf file / test / config / doc with no consumers, **or** an edit confined to a single file whose changed symbols have no consumers outside it (module-private helpers, internal-only code). Check consumers before assuming `local` — "existing file" alone does not make a change `local`, and treating it that way keeps the cheap tier permanently unreachable.
- otherwise `local`.
- **high-risk paths** (a subset of `wide`, tracked separately): migrations, auth/permissions/security, dependency manifests. Their failure mode does not scale with line count, so 3.4 keeps them at the top tier at any size.

**3.4. Assign a tier** (`depth` `deep`/`minimal` overrides auto-classification):
- **T0 trivial** — `none` code (non-code only).
- **T1 minimal** — `small` + `isolated`.
- **T2 standard** — `small`/`medium` + `local`, or `medium` + `isolated`, or `small` + `wide` when no high-risk path is touched.
- **T3 deep** — `large`, OR a structural change, OR `wide` at `medium`+ size, OR — at any size — a **high-risk path** (migrations, auth/permissions/security, dependency manifests).

**Proportionality (do not skip this reasoning).** Blast radius decides *which* lane you cannot skip; effective size decides *how many* lanes are worth paying for. A 20-line edit to a shared module needs consumer tracing (`impact`) — it does not need an architecture verdict, and a full panel there spends four independent repo sweeps to re-read the same 20 lines. High-risk paths are the deliberate exception: a 3-line auth or migration change stays T3.

**3.5. Tier → dimensions and sources:**

| Tier | DIMS (Claude agents) | Consultants | Sceptic |
|---|---|---|---|
| T0 trivial | — (no full panel) | — | — |
| T1 minimal | impact | consultant (§2) | strict (P0/P1) |
| T2 standard | impact + quality (+ tests if tests present) | consultant (§2) | strict (P0/P1) |
| T3 deep | impact + quality + architecture (+ tests if tests present) | consultant (§2) | strict (P0/P1) |

Modifiers on top of the tier:
- `dims` (when not `tier`) overrides the lanes at any tier: a set replaces them, `add`/`remove` adjust the tier's lanes — if that leaves zero lanes, say so and stop; without it, tests are added only when test files are present in the diff.
- `extra=pi` adds pi as an extra consultant at any tier (including T1; not T0 — T0 runs nothing).
- the sceptic pass (section 8) runs **strict by default** on any P0/P1 findings — `sceptic=basic` drops the refuter vote, `sceptic=off` disables it.
- **T0:** do not run agents/consultants. Do a light pass yourself (Opus): quickly check the non-code for gross errors (broken JSON/YAML, obvious config typos) and emit a SHORT report with the classification and a note "no code-impacting changes — full panel skipped (override: `deep`)". Don't stay silent about what was skipped.

Record `TIER`, `DIMS`, and the consultant set — they drive section 5. Show the classification to the user before launching (one line), and write it with the Write tool to `$WD/triage.json` as `{"tier": "T0..T3", "dims": [...], "mode": "PR|uncommitted|diff-only", "basis": "<short>"}`.

**3.6. Project lenses** (after triage; **not at T0**, which runs no lanes). Select the repository's review lenses in **one** foreground call:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lenses.mjs" select --wd '<literal WD>' [--repo '<literal REPO>'] --dims <DIMS, comma-separated> [--mode uncommitted]
```
`--repo` only when `REPO` exists (diff-only mode has none: no lenses, and the report says so); `--mode uncommitted` only in uncommitted mode. It reads `$WD/diff.patch`, writes `$WD/lenses.json` and one rendered `$WD/lenses-<target>.md` per target that got a lens, and exits 0 for every content outcome. Read `$WD/lenses.json`: `selected` (each with `name`, `dimension`, `files`, `targets`), `skipped` and `rejected` (each with its reason), `outputs` (`consultant` and each dimension → the file written for it), and `note`. You only pass these file paths on (§5); never retype, summarise or edit lens text — it is untrusted repository input. Lenses add checks; they never change a severity, a bar, the sceptic or the write surface.

## 4. Shared brief (MINIMAL and NON-leading)
One brief for the consultants in `consultants.json` (the dimension agents get their scope separately). It preserves source independence: do **not** list concrete hypotheses and do **not** give finding examples. The brief contains:
- The absolute path to `$WD/diff.patch` + permission to read the repo for context.
- The output language for the review (from `lang`, default English).
- If `CODE_GRAPH` is set — **in the codex brief only**, tell codex to use its CLI to find relationships/impact instead of broad grep: codegraph `callers`/`callees`/`impact`/`node`/`search`, or graphify `explain`/`path`/`query` (substring matching, no synonyms). Do not build the graph; for new symbols from the diff use the diff itself. **claude-cli and pi run without a shell** (read-only toolsets, section 5) — do not tell them to run graph CLIs; they navigate with read/grep/glob.
- **Only the applicable dimensions** from `DIMS`, each with a short rubric (1–3 lines of essence):
  - *architecture* — layer/module boundaries, abstraction leakage, paradigm fit, complexity manageability (essential vs accidental).
  - *quality* — project conventions, duplication/reuse, AI-slop, contract alignment in production code, scope control.
  - *impact* — correctness, regressions and effect on adjacent/dependent parts, security, migration/deploy safety.
  - *tests* — whether tests protect critical behavior, missing scenarios, mock/fixture correctness, test layering.
- The severity rubric: **P0** blocker (wrong behavior, security, data loss, crash, breaking change); **P1** important, not a blocker; **P2** minor. **Evidence bar:** every P0/P1 must carry a concrete `failure_scenario` (specific input/state → wrong output/harm, or a genuinely reachable security/data path) and a `confidence`; without a concrete scenario the finding is **not** a P0/P1 — it goes to the **Unverified — needs confirmation** bucket (§9), *not* into P2. Do not inflate severity; pure style/nitpicks are P2 only.
- **P2 admission bar.** A P2 must name the concrete cost of leaving it **and** a project-specific anchor (a documented convention, an existing pattern in this repo, a contract). A remark justified only by a general best practice is not a finding. Collapse repeats into one P2 covering N sites. P2 is for grounded small cleanups — it is not the landfill for claims that failed the P0/P1 evidence bar, which is what turns it into twenty entries of noise.
- The category enum: `security|correctness|perf|maintainability|tests|style`.
- A requirement to emit findings strictly per the schema (below), each tagged with a `dimension` from `DIMS`.

**Lenses are not part of the brief.** Do not copy lens text into it; the §5 helper appends `lenses-consultant.md` to the prompt itself.

Write the brief to each file named by a lane's `brief` in `consultants.json`: `$WD/brief.md` serves the schema lanes (codex, claude-cli), `$WD/brief-pi.md` the pi variant (§5) — the §5 helper reads it from there.

Findings schema — the §5 helper hands the schema lanes (codex, claude-cli) the canonical `contracts/finding.schema.json` itself; this copy is what the pi brief quotes, **verbatim**:
<!-- BEGIN GENERATED: contracts/finding.schema.json -->
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "title": {
            "type": "string"
          },
          "file": {
            "type": "string"
          },
          "line": {
            "type": [
              "string",
              "null"
            ]
          },
          "severity": {
            "type": "string",
            "enum": [
              "P0",
              "P1",
              "P2"
            ]
          },
          "dimension": {
            "type": "string",
            "enum": [
              "architecture",
              "quality",
              "impact",
              "tests"
            ]
          },
          "category": {
            "type": "string",
            "enum": [
              "security",
              "correctness",
              "perf",
              "maintainability",
              "tests",
              "style"
            ]
          },
          "rationale": {
            "type": "string"
          },
          "failure_scenario": {
            "type": [
              "string",
              "null"
            ]
          },
          "confidence": {
            "type": "string",
            "enum": [
              "low",
              "medium",
              "high"
            ]
          },
          "suggested_fix": {
            "type": [
              "string",
              "null"
            ]
          },
          "owner": {
            "type": [
              "string",
              "null"
            ],
            "enum": [
              "architecture",
              "quality",
              "impact",
              "tests",
              null
            ]
          },
          "lens": {
            "type": [
              "string",
              "null"
            ]
          }
        },
        "required": [
          "title",
          "file",
          "line",
          "severity",
          "dimension",
          "category",
          "rationale",
          "failure_scenario",
          "confidence",
          "suggested_fix",
          "owner",
          "lens"
        ]
      }
    }
  },
  "required": [
    "findings"
  ]
}
```
<!-- END GENERATED -->
**Do not "simplify" this schema.** `--output-schema` goes to OpenAI structured outputs in strict mode, which rejects the whole run with `invalid_json_schema` (HTTP 400, before any work is done) unless *every* object carries `"additionalProperties": false` **and** its `required` lists *every* key in `properties`. Optional fields are therefore expressed as nullable (`["string","null"]`), not by omission from `required` — a finding with no line/scenario/fix emits `null` there.

## 5. Run reviews (independent sources, in parallel)

Run only what the tier assigns (section 3.5): T0 — neither agents nor consultants (short report); T1 — impact agent + consultant; T2/T3 — assigned agents + consultant. `dims=`, `extra=pi`, `sceptic=off|basic`, `timeout=` and `depth` (`deep`/`minimal`) apply as modifiers (§0). The tests dimension is added automatically whenever the diff contains test files — `dims=+tests` forces it when it does not.

**Claude lane — dimension agents.** For EACH dimension in `DIMS`, run the matching subagent via Task (in parallel, in one message):
- architecture → `Task(subagent_type="arch-reviewer")`
- quality → `Task(subagent_type="quality-reviewer")`
- impact → `Task(subagent_type="impact-reviewer")`
- tests → `Task(subagent_type="test-reviewer")`

**Model per dimension (set in each agent's frontmatter, not here).** `impact` and `architecture`
run on Opus; `quality` and `tests` run on Sonnet. The split is by what the dimension actually does:
tracing call sites and reasoning about regressions or future complexity is what the larger model is
for, while convention alignment, duplication and mock drift are largely recognition against
precedent the repo already sets. `finding-verifier` stays on Opus deliberately — a weaker reviewer
misses findings, but a weaker sceptic lets **false** ones through, and one confirmed false P0 costs
more trust than a missed bug costs coverage.

This allocation is a judgement, not a measurement: the repository has no behavioural evals yet, so
the effect on recall is unverified. Issue #1 (the eval corpus) is what would settle it.
Note: when installed as a plugin the agents may be namespaced — if a bare name does not resolve, use `consensus-review:arch-reviewer`, `consensus-review:quality-reviewer`, `consensus-review:impact-reviewer`, `consensus-review:test-reviewer`.
Pass each one: the path to `$WD/diff.patch`, `REPO`, the mode (PR/uncommitted/diff-only), the output language (from `lang`), the path `$WD/<outputs.<dim>>` from `lenses.json` when that output is set (the agent reads it as advisory project lenses; nothing when unset), and **`TIER` with an exploration budget** — T1/T2 means "the diff plus its nearest context and direct consumers; do not sweep the repository", T3 means the full protocol. Each agent explores independently (that is what buys source independence), so an unbounded brief multiplies the same repo walk by the number of lanes. Their structured output is the Claude lane's share of the findings, each already carrying its `dimension`. The **same P0/P1 evidence bar and P2 admission bar** are built into each agent prompt, so every lane is held to one standard — the consultant brief in §4 is not a stricter rule for the consultants alone, and the standalone `/arch-review`-style commands keep the bar even without an orchestrator.

**Consultant lanes** (every entry of `consultants.json` `lanes`) — through the lane helper `scripts/run-lane.mjs`, never by calling `codex`/`pi`/`claude` directly. The helper owns the read-only flags, the per-attempt timeout, the single retry and killing each attempt's process group; it writes `$WD/<name>.status.json` per lane and, only on success, the canonical `$WD/<name>.json`.

Make this **ONE Bash call with `run_in_background: true`**: one shell owns every node process, so `wait` is valid and `decide` runs after all of them. Separate background calls (one per lane) are still forbidden — nothing would own all the processes. Shell state does not persist between calls, so write every value (`$WD`, `$REPO`, `T`, each lane's fields) as a **literal**.
```bash
WD='/tmp/tmp.XXXX' REPO='/abs/repo' T=900   # literals; T = settings.timeout.value
H="${CLAUDE_PLUGIN_ROOT}/scripts/run-lane.mjs"
# one line per consultants.json lane, its name/brief/model/skip/skipReason copied literally
node "$H" run <name> --wd "$WD" --name <name> --repo "$REPO" --brief-file "$WD/<brief>" --timeout "$T" [--model '<model>'] [--lenses-file "$WD/<outputs.consultant>"] [--skip <skip> --skip-reason '<skipReason>'] &
wait
node "$H" decide --wd "$WD" --phase review --lanes <name>[,<name>…]   # every lane name, in consultants.json order
```
- Add `--model` only when the lane's `model` is non-null, `--lenses-file` only when `lenses.json` `outputs.consultant` is set, and `--skip … --skip-reason …` only when its `skip` is. The helper appends the lenses file to the brief (`brief + "\n\n" + lenses`); a missing or unreadable file runs the lane on the brief alone and its status says `lenses: "missing"`.
- **While the call runs**, launch the dimension agents (above). On the call's completion notice, read `$WD/review.decision.json`.
- **No notice?** Poll the literal path in a foreground call, e.g. `timeout 540 sh -c 'until [ -f /tmp/tmp.XXXX/review.decision.json ]; do sleep 5; done'`, repeated until **2×T + 60 s** in total (count whole seconds). Pass **`timeout: 600000`** on that Bash call: the tool's default is 120 s, which would kill the poll long before `timeout 540`. If the file is still missing, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/run-lane.mjs" decide --wd '<literal WD>' --phase review --lanes <same list>` yourself: a lane without a status is then reported `failed: helper error (no status written)`, never as zero findings. `review.decision.json` is write-once — whichever `decide` runs first wins, a later one leaves it as is — so read the file after your `decide`, whoever wrote it.
- claude-cli read-only enforcement is the flag set the helper passes (`--safe-mode --restricted --tools Read,Grep,Glob`, no MCP servers, no session persistence, `--add-dir $WD`); it runs in `$REPO` on the user's Claude quota.
- pi read-only enforcement is the **toolset** the helper passes (`--tools read,grep,find,ls --no-mcp` — no `edit`, `write` or `bash`, and no MCP server tools, which `--tools` alone keeps; pi has no sandbox flag), plus `--no-extensions --no-session --no-skills --no-prompt-templates --no-context-files --no-approve`, so no extension code, saved session, skills or context files. A model whose provider only an extension supplies (e.g. `claude-bridge`) is therefore not available, even as an explicit `pi-model=<model>`. It runs in `$REPO`, so give the diff by its **absolute** `$WD/diff.patch` path in the brief.
- pi has no output-schema flag. In `$WD/brief-pi.md` add: "Output the findings strictly as a JSON array per the schema between the markers `===FINDINGS_START===` and `===FINDINGS_END===`" — the helper takes the last such block and treats its absence as `unparseable`.

## 6. Collect and normalize
- dimension agents: take their structured findings, normalize to the common schema (the `dimension` field is known from the agent), `source = claude`.
- consultants: read `$WD/review.decision.json` — `lanes.<name>` is each lane's status (`status`, `display`, `attempts[]`, and for pi `provider`/`model`); top-level `family.<name>` is the lane's model family (`openai`, `anthropic`, `zhipu`, … or `unknown`) and top-level `independence.<name>` is `model | context | unknown`; plus `allExternalDown`, `extraSameEngine` and `refuters` (keyed `<name>-refuter`). Read findings from `$WD/<name>.json` **only when that lane's `status` is `ok`**; the file exists only then. A missing or unreadable file is never "zero findings" — the lane's `display` says why (`degraded (timeout; failed: <reason>)`, `failed: <config reason>`, `failed: helper error (…)`). Treat `null` in `line`/`failure_scenario`/`suggested_fix` as "not provided". A `failed: <reason>` without retry is a config bug to fix (bad auth, rejected schema), not a clean review.
- pi: `$WD/pi.json` is already parsed from the markers. Report pi's actual `provider`/`model` from its status in section 9 and apply the independence check from section 0.
- claude-cli: with `--json-schema` a refusal comes back as empty findings, so an empty `claude-cli` result is weak evidence — covered by the context-independent note (§9), never a clean bill.
- **Lens attribution.** An agent finding with a `Lens: <name>` line gets `lens: <name>`, otherwise `lens: null`; a consultant's `lens` field is kept as it came (missing → `null`).
- Tag every finding with `source` (`claude`/`codex`/`pi`/`claude-cli`) and `dimension`, and **preserve `owner`** when the reporting lane set it — normalizing it away is what turns the §7 owner rule into a no-op.
- Write the Claude lane's findings **as received, before any merging**, with the Write tool to `$WD/claude-findings.json` as `{"findings": [...]}` (each with its `dimension`, `owner` and `lens` kept).
- **Floor case:** when `allExternalDown` is true (no external lane ended `ok*`) — build the report from the Claude dimension agents only, with the §9 top warning `> **Single-source review (Claude only):** …`; do not abort.

## 7. Consensus synthesis (you are the arbiter)
- **You do NOT author findings yourself.** Findings come only from the independent dimension agents + the consultants — each a separate context. You merge/dedup/rank; you never grade your own review — the sceptic pass (§8) is run by a separate independent verifier to avoid confirmation bias.
- **Dedup** overlapping findings by (file, line neighborhood, meaning) — across sources AND across dimensions (the same problem may surface as both impact and quality — merge, keep the more precise `dimension`). When in doubt, don't merge; mark as related.
- **Agreement badge** `[claude|codex|pi|claude-cli]` — who found it (merged duplicates combine their sources). The token names the **lane, not the model**: every dimension agent is `source = claude` whichever model it runs on (§6), so two Claude lanes reporting the same problem merge into a single `[claude]` — cross-dimension overlap never inflates the badge.
- **Agreement counts families, not tokens.** The number of sources is the number of distinct **known** families among the badge's lanes: `claude` is `anthropic`, every other lane's family is `family.<name>` in `review.decision.json` (§6), and a lane whose family is `unknown` adds nothing. So `[claude|claude-cli]` is **one** source (both `anthropic`, `independence.claude-cli` is `context`), and `[claude|codex|pi]` with codex and pi both on `openai` is **two** sources, not three. The single-source rule (below, §8, §9) uses the same count.
- **`owner:` tags.** A lane may report something outside its own protocol and tag it `owner: <lane>` (e.g. quality flags a probable bug it cannot trace to consumers). If that lane ran, normal dedup applies — merge and keep the more precise `dimension`. **If that lane did not run in this review** (architecture is absent at T2; `dims=` can narrow the panel further), the finding is *ungraded*: keep the reporter's severity, do not demote it for being out-of-lane, and mark it in the report as `owner lane not in this run — ungraded`. A finding must never be lost because the lane that owns it was skipped.
- **`lens`.** A `lens` value that is not a `selected` name in `$WD/lenses.json` becomes `null`; log it as `lens dropped (unknown: <value>)`. A merged finding's `lens` is the first non-null selected name among its sources, in name order. A lens never changes a severity: grade the finding as if it had none.
- Assign the **final severity** per the impact rubric (the decision is yours; source agreement influences confidence).
- Keep minority/disputed findings (single source, i.e. one family) with an annotation; never drop them silently.
- Give **every** merged finding a string id (`F1`, `F2`, …) in report order, and write the merged list with the Write tool to `$WD/synthesis.json` as `{"findings": [{"id": "F1", …}, …]}` (each with `source`, `dimension`, `lens`, final `severity`). These ids are the only ids of this run — §8 reuses them and never renumbers.

## 8. Sceptic pass (STRICT by default; `sceptic=basic` softens it, `sceptic=off` skips it) — INDEPENDENT verification
To avoid confirmation bias, the sceptic pass is performed by an **independent verifier agent with fresh context** — NOT by you (the arbiter), and NOT by the agent that produced the finding. You only apply its verdicts.
- Collect the P0/P1 findings (P2 isn't worth verifying), each with its id from `$WD/synthesis.json` — in both modes, never renumbered — and write those ids as a JSON array to `$WD/ids.json` (both modes: `decide` reads it). Spawn `finding-verifier` via Task (batched — pass the whole list in one call; split into a few calls if large), giving it ONLY: the path to `$WD/diff.patch`, `REPO`, and the findings (id, title, `file:line`, severity, dimension, claimed `failure_scenario`, source, rationale). Do NOT pass your synthesis reasoning, and pass **no lens**: no lens text, no lenses file and no `lens` field go to the verifier or the refuters — they judge the code, not the project's checklist. Namespaced fallback: `consensus-review:finding-verifier`.
- When `finding-verifier` returns, write its JSON verdict array verbatim to `$WD/verifier.verdicts.json` **only if** it returned a usable JSON array; otherwise write nothing. If you split it into several calls, concatenate the verdict arrays from all of them into that one file (still only usable arrays). This holds in `basic` and `strict` alike.
- **Strict — the default.** Additionally enlist the consultants as refuters, who vote alongside the verifier. `sceptic=basic` skips this paragraph (no refuter runs) and goes straight to **Decide**.
  - Write a refuter brief ("argue why each finding is NOT real", the same findings fields the verifier gets, the output language, and one vote per finding: `AGREE` when it holds, with the harm path at `file:line`; `DISAGREE_EVIDENCE` only with a `citation` whose `quote` is a contiguous excerpt copied verbatim from the reviewed head code, with its `file` and `line`, no `...`; `DISAGREE_CONCERN` for a doubt you cannot ground that way — a doubt without a quote does not count against the finding) to each `$WD/<refuterBrief>` of a lane whose refuter is marked `run`: `$WD/refuter-brief.md` for the schema lanes, `$WD/refuter-brief-pi.md` for pi — the same text plus "Output the verdicts strictly as a JSON array of objects of this shape between the markers `===VERDICTS_START===` and `===VERDICTS_END===`:" followed by this block:
<!-- BEGIN GENERATED: contracts/verdict.schema.json#/properties/verdicts/items -->
```
{
  "id": str,
  "verdict": "AGREE"|"DISAGREE_EVIDENCE"|"DISAGREE_CONCERN",
  "evidence": str,
  "citation": {"file": str, "line": str, "quote": str}|null,
  "suggested_severity": "P0"|"P1"|"P2"|null
}
```
<!-- END GENERATED -->
  - Which refuters run is already decided in `review.decision.json` (`refuters`) — do not re-derive it. The helper reads it, runs a refuter marked `run`, and writes the recorded `skipped (…)` status for the rest without starting anything. Run them with the **same backgrounded-call protocol as §5** (one `run_in_background: true` call with literal values; without a completion notice, the bounded literal-path poll — here on each `$WD/<name>-refuter.status.json` — up to 2×T + 60 s, each poll call with `timeout: 600000`, then `decide` regardless), launching `finding-verifier` while it runs:
    ```bash
    WD='/tmp/tmp.XXXX' REPO='/abs/repo' T=900   # literals; T = settings.timeout.value
    H="${CLAUDE_PLUGIN_ROOT}/scripts/run-lane.mjs"
    # one line per consultants.json lane, as in §5 (same --model); --schema only for the schema lanes (codex, claude-cli)
    node "$H" run <name> --wd "$WD" --name <name>-refuter --repo "$REPO" --brief-file "$WD/<refuterBrief>" --timeout "$T" \
      --from-decision "$WD/review.decision.json" [--schema "${CLAUDE_PLUGIN_ROOT}/contracts/verdict.schema.json"] \
      --require-key verdicts --ids-file "$WD/ids.json" [--model '<model>'] &
    wait
    ```
- **Decide — both modes.** Once `$WD/verifier.verdicts.json` is written (or `finding-verifier` returned nothing usable) and, in strict, the refuter statuses exist (or the bounded poll above has run out), always run in a foreground call:
  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/run-lane.mjs" decide --wd '<literal WD>' --phase sceptic --lanes <name>-refuter[,<name>-refuter…] [--repo '<literal REPO>'] [--head-sha '<literal HEAD_SHA>']
  ```
  Strict lists every lane's refuter; basic passes `--lanes ""`. Add `--repo` only when there is a clone, and `--head-sha` only when §1 recorded a non-empty `HEAD_SHA`; diff-only mode passes neither. Then read `$WD/sceptic.decision.json` (both modes): `perFinding.<id>.decision` is the verdict to apply, `voters` reads `n of m`, `noVote` names the voters that cast no vote on it, `votes` maps each voter to its vote, `downgraded` maps a voter whose `DISAGREE_EVIDENCE` did not verify to the reason, and `render` holds the report tokens (`label`, `concerns`, `refutation`); top level, `verifier` is `ok | missing | invalid`, `excluded` maps a refuter left out of the ballot to its reason, and `voteMode` is `basic`, `strict`, `strict → basic`, or `strict → basic (no independent refuter)`. Every id from `$WD/ids.json` has a decision. Report `verifier=missing|invalid` in section 9.
- **Fallback — the one rule.** If `sceptic.decision.json` is missing, has no `perFinding`, or carries `error` (e.g. `failed: helper error (no ids)`), apply none of it. For each P0/P1 id of `$WD/synthesis.json`: exactly one verifier vote on it, and that vote `AGREE` (or the legacy `confirmed`) → `confirmed`; anything else — another verdict, no vote, a duplicated vote, missing or invalid verifier output → `unconfirmed`. Nothing is `refuted` without `decide`: its quote was never checked. Votes on a P2 or an unknown id are ignored. Say `sceptic: fallback (<why>)` in section 9.
- **The vote rules** (`decide` applies them; do not re-derive). Voters are the verifier plus the refuters kept after family exclusion; a refuter that failed or timed out casts no vote rather than a negative one — an infrastructure failure must not remove a real P0. Per finding, `cast` = voters with a valid vote, `A` = `AGREE` votes, `E` = `DISAGREE_EVIDENCE` votes whose quote verified; a concern counts in `cast` only. In order:
  1. no verifier vote → `unconfirmed` — a refuter never decides alone;
  2. `E > A` and (the verifier's vote is a verified `DISAGREE_EVIDENCE`, or `2·E > cast`) → `refuted`;
  3. `A > E` and (the verifier voted `AGREE`, or `2·A > cast`) → `confirmed`, concerns attached;
  4. anything else → `unconfirmed`.

  | Votes (V = verifier, R = refuter) | Decision |
  |---|---|
  | V AGREE, every other vote a concern | `confirmed` |
  | V EVIDENCE, every other vote a concern | `refuted` |
  | AGREE and EVIDENCE tied (V AGREE + R EVIDENCE, V EVIDENCE + R AGREE) | `unconfirmed` |
  | V CONCERN + one R AGREE or one R EVIDENCE | `unconfirmed` — a lone refuter neither confirms nor refutes |
  | V CONCERN + two R AGREE / two R EVIDENCE (three voters) | `confirmed` / `refuted` |
  | V AGREE + two R EVIDENCE / V AGREE + R EVIDENCE + R AGREE | `refuted` / `confirmed` |
  | no verifier vote, or only concerns | `unconfirmed` |

  A `DISAGREE_EVIDENCE` whose quote does not verify counts as a concern, named in `downgraded` (`cannot verify outside diff`, `elided quote`, …). The check proves only that the quote exists within a few lines of the cited line, not that it is relevant. It reads the diff's new side, and outside the diff only the clone at `HEAD_SHA`; in PR mode a head commit missing from the local clone makes every quote outside the diff a concern. When no refuter voted at all, `voteMode` is `strict → basic` and the verifier's votes apply; when every refuter was skipped or excluded for family reasons, it is `strict → basic (no independent refuter)`. Say which in section 9.
- Apply the verdicts. Copy every concern text, location and quote from `perFinding.<id>.render` (or `notes`), never from the raw verifier or refuter payloads; write the surrounding prose in `lang` and copy the tokens (`label`, voter names, texts, quotes) as they are:
  - `refuted` → drop (P1/P2, logged) or, for P0, move to **Unverified — needs confirmation**; either way cite `render.refutation.loc` and its quote, shown as `fence` + newline + `quote` + newline + `fence` (the `fence` given, so the quote cannot break the layout).
  - `unconfirmed` → downgrade; single-source-unconfirmed → **Unconfirmed (single-source)**; a P0 → **Unverified — needs confirmation** (not counted in Totals P0), with any concern texts as the reason and, when a verified quote tied an AGREE, that quote from `notes.<voter>.citation`, fenced with backticks one longer than its longest backtick run and at least three.
  - `confirmed` → keep; mark it "survived sceptic (`<render.label>`)" — those words in `lang`, the label as-is — and add each `render.concerns` entry as `<voter>: <text>`. In the fallback there is no `render`: the label is `verifier: AGREE` and there are no concerns.
  - Every `downgraded` entry is logged under **Dropped / Downgraded (sceptic)**: `<id> <voter>: EVIDENCE → CONCERN (<reason>)`.
- **P0 is never silently dropped** — it is either `confirmed` (stays P0, with evidence) or moved to the Unverified bucket with a reason.
- **No silent drops:** log every drop/downgrade/move together with its votes.

## 9. Report
Write the report in the selected output language (`lang`, default English); tokens copied from `sceptic.decision.json` (labels, voter names, vote kinds, concern texts, quotes) stay as they are. Sort P0→P1→P2 (within a tier — by agreement desc, then dimension/file). Print to the terminal **and** save the file, unless `out` is `none` (terminal only, zero writes, no archive call). Destination: the `out` path when it is not `default` (directory value → default filename inside it; otherwise the exact path), else `<INVOKE>/.reviews/review-<slug>-<YYYY-MM-DD>.md` (create the dir; for the remote-PR diff-only case write to the invoking repo's `.reviews/`). State the destination — or "not written (`out=none`)" — in the last line of the terminal output.

**Archive — on the file branch only, never with `out=none`.** Before writing the report, run in a foreground call, with the literals from §1 and the final report path:
```bash
cd '<literal INVOKE>' && node "${CLAUDE_PLUGIN_ROOT}/scripts/archive-run.mjs" finish --wd '<literal WD>' --report '<final report path>'   # add --off with archive=off
```
It reads `$WD/settings.json` and `$WD/triage.json` itself.
It prints one JSON line and exits 0 either way: `{"dir":"…"}` → `Archive: <dir relative to INVOKE>`; `{"skipped":"…"}` → `Archive: not written (<reason>)`. A failed or unparseable call is `Archive: not written (<what happened>)`; the report is still written and the review's outcome is unchanged. Put that `Archive:` line in the header block and append it to the last terminal line. With `out=none` there is no `Archive:` line.

Format (`<lines.settings>` and `<lines.ignored>` are the `Settings:` and `Ignored args:` lines copied **verbatim** from `$WD/settings.json`; the extra lane's model shows in `Sources` / `Source availability`):
```
# Consensus Review — <target: PR #N url | uncommitted in <repo>>
<only when review.decision.json has allExternalDown: true (never at T0, where no consultant runs):>
> **Single-source review (Claude only):** <name>=<display> for each lane. No external model cross-checked these findings.
<only when every ok external lane has `independence.<name>` = "context" in review.decision.json:>
> Consultant is the same model family as the panel (claude-cli): context-independent only.

base→head: <…> | date: <…> | consultant: <name> (<reason>)
<lines.settings>
<lines.ignored>
Classification: tier=<T0..T3> | effective code: <~N lines / M files> | non-code excluded: <K lines (.bru/lock/docs)> | blast: <isolated|local|wide> | basis: <short>
Dimensions: <architecture? quality impact tests?>  (applied / skipped with reason)
Lenses: <name> (<dim|all>; <n> files) … | skipped: <name> (<reason>) … | rejected: <n> | not delivered to <lane>   <`not delivered` for each lane whose status has `lenses: "missing"`; or `Lenses: none`, or the lenses.json `note`>
Sources: <each lane's `display`, refuters included> — e.g. codex=ok (retried: unparseable), pi=degraded (timeout; failed: rate limit), claude-cli=ok, claude-cli-refuter=skipped (same-family), claude=ok
Code graph: <codegraph|graphify|none> (used for navigation/blast-radius)
Archive: <.reviews/<run-id> | not written (<reason>)>   <omitted with out=none>
Totals: P0=<n> P1=<n> P2=<n>

## P0
### <title>  `file:line`  [claude|codex|pi|claude-cli]  (dimension/category)<, survived sceptic (<render.label>)><, lens: <name>>
<rationale>
**Fix:** <suggested_fix>
...
## P1
## P2
<Up to 7 entries individually, highest confidence first; everything beyond that grouped by theme, one line each —
 `- <theme> ×<N> — file:line, file:line, … (confidence: <low|medium|high>)`. `low`-confidence P2s always go to the grouped lines, never the individual list.
 This is presentation only: `Totals` keeps the true count, every file still appears, and the run archive keeps every P2. Nothing is dropped silently.>

## Dimension summary
| Dimension | Status | P0 | P1 | P2 |
|---|---|---|---|---|
| architecture | applied/skipped(reason) | n | n | n |
| quality | … | | | |
| impact | … | | | |
| tests | applied/skipped(no tests) | | | |

## Unconfirmed (single-source)
<findings from only one known model family (counted from `family.<name>`, §7) not independently grounded (populated more aggressively under sceptic); with annotation>

## Unverified — needs confirmation
<P0s whose failure scenario was not concretely grounded (sceptic) — NOT counted as confirmed P0 in Totals>

## Dropped / Downgraded (sceptic)
<dropped P1/P2 + downgrades, each with the reason, and every `downgraded` vote (`F2 codex: EVIDENCE → CONCERN (cannot verify outside diff)`) — only when sceptic is on (basic or strict)>

## Source availability
<one line per external lane (refuters included) with its attempts from `attempts[]`, e.g.
 `codex: degraded — attempt 1: timeout (900s); attempt 2: failed: stream disconnected (412s)`,
 `codex-refuter: ok (retried: failed) — attempt 1: failed: rate limit (35s); attempt 2: ok (610s)`;
 skipped/unavailable lanes with their reason; diff-only mode, etc.
 sceptic (basic or strict): `voteMode: basic | strict | strict → basic | strict → basic (no independent refuter)`, or `fallback (<why>)`; `verifier` when it is not `ok`; each `excluded` refuter with its reason; and per finding the voters and the votes — `F1: 2 of 2 voters — verifier: AGREE, codex: CONCERN`, `F3: 1 of 2 voters (no vote: codex-refuter) — verifier: AGREE`.
 with a pi lane: pi's resolved provider/model; with `extraSameEngine: true`, a note that the extra lane is the same family as the consultant and adds little independence — suggest pi-model=<other-model>>
```

## Hard rules
- **Read-only:** do not edit code, commit, push, comment on the PR, or run fixes. The only writes are the report file (`.reviews/` by default, or `out=<path>`) and its private run archive (`<INVOKE>/.reviews/<run-id>/`, unless `archive=off`) — and with `out=none` (`no-file`) there is no write at all.
- Working files only in `$WD` (mktemp outside the repo).
- Lenses never change a severity, a bar, the sceptic or the write surface.
- Never "lose" a source or dimension silently — skips and unavailability always appear in the report ("Dimension summary" and "Source availability" sections).
