---
description: Consensus code review (Opus arbiter + a consultant — codex, else pi, else claude-cli — optional pi advisor) across 4 dimensions (architecture/quality/impact/tests) for a PR or uncommitted changes; P0–P2 findings; strict sceptic by default; every flag also accepted with a leading --
argument-hint: "[<PR-url|owner/repo#N|#N>] [deep|minimal] [dims=<list>|arch] [sceptic=off|basic|strict] [consultant=<codex|pi|claude-cli|claude>] [extra-advisor[=<model>]] [timeout=<sec>] [p2=grouped|full|off] [out=<path>|no-file] [archive=off] [lang=<language>]"
---

You are the **Opus arbiter** of a consensus review. Review runs by **dimensions** (what
to check) using **independent** reviewers (who checks): your dimension agents + one consultant
(`codex`, else `pi` ([pi.dev](https://pi.dev)), else `claude-cli`), plus the optional extra advisor `pi` when asked for.
Merge everything into a single consensus report with P0–P2 findings.
This is a **read-only** review: do not fix, commit, push, or comment on the PR.
The only writes are the markdown report file and its private run archive — and none at all with `no-file`.

Arguments: `$ARGUMENTS`

## 0. Parse arguments

**Flag syntax — one rule for all of them.** Every flag is accepted with or without a leading `--` (`arch` ≡ `--arch`, `dims=…` ≡ `--dims=…`); values attach with `=`, never a space; matching is case-insensitive. Do not special-case individual flags.

**Unknown tokens are ignored but never swallowed.** Collect anything unrecognized and echo it in the report header as `Ignored args: <…>`. A typo like `sceptic=strct` or `dimz=impact` must surface — silently falling back to the default is how a user ends up believing they ran something they did not. (This is also where the retired `codex-only` flag now lands: one consultant is the default, so the flag has no meaning and is simply reported as ignored.)

**Two orthogonal axes.** Depth and lanes are separate knobs, so most "conflicting" combinations are not conflicts at all:
- **Depth** (`TIER`) — how much exploration each lane pays for: `minimal` | `deep`/`full` | auto-classified (default, §3).
- **Lanes** (`DIMS`) — which dimensions run: `dims=…` | `arch` | derived from the tier (§3.5).

Resolution rules, in full:
- Within the depth axis only: if both `minimal` and `deep` are given, **`deep` wins** — an explicit escalation beats an explicit de-escalation — and the loser goes into `Ignored args` so the user sees which one applied.
- Across the axes there is nothing to resolve. `minimal arch` is a legitimate request for a shallow architecture-aware pass (T1 exploration budget, lanes impact + architecture). `deep arch` makes `arch` a no-op, because T3 already includes architecture — report it as ignored rather than pretending it changed anything.

- A PR URL / `owner/repo#N` / `#N` in the args → **PR mode**. Otherwise → **uncommitted mode**.
- `deep` / `full` → force the maximum tier (full panel + every enabled consultant), skipping auto-classification. Does **not** imply `extra-advisor` — combine them if you want pi too.
- `minimal` → force the minimal tier, skipping auto-classification.
- `dims=<list>` → set the lanes explicitly, overriding what the tier would pick. **Absolute** form replaces the set (`dims=impact,quality`); **relative** form adjusts it (`dims=+tests,-quality`). Names: `architecture` (or `arch`), `quality`, `impact`, `tests` — comma-separated, no spaces. An absolute list that resolves to zero lanes is an error: say so and stop, rather than running a review with no reviewers. `dims=+tests` is the only way to get a test review when the diff itself contains no test files — the case where a change is covered by an existing suite it affects only indirectly.
- `arch` → alias for `dims=+architecture`.
- **Sceptic is ON and STRICT by default.** Canonical knob: `sceptic=off|basic|strict`, default `strict`.
  - `strict` (default) — the independent verifier **plus** the consultants re-run as refuters, with a majority vote per finding (§8).
  - `basic` — the independent verifier only: no refuter re-runs, no vote.
  - `off` — no sceptic pass at all. `no-sceptic` / `--no-sceptic` is a kept alias for `sceptic=off`.
  The pass only fires when there are P0/P1 findings, so trivial/clean reviews pay nothing at any setting. Strict costs one extra run per voting consultant on the reviews that do have P0/P1 — and note the vote arithmetic in §8: with the default two-voter set a tie is not a confirmation, so strict-by-default means findings need both voters to survive as stated; with three voters (codex plus pi on an independent family as extra) 2 of 3 confirm.
  **One refuter per model family** (intended change): a consultant of the panel's family (claude-cli, or pi on a Claude model), a second lane of a family that already votes (pi on OpenAI next to codex), or an `unknown` family gets no refuter. codex plus pi on OpenAI used to run two refuters; it now runs one.
- **One consultant, detected.** By default the consultant is the first installed of `codex` → `pi` → `claude-cli` (a nested read-only `claude -p`, model `sonnet`). `consultant=<codex|pi|claude-cli>` forces one (`claude` ≡ `claude-cli`); a forced consultant that is missing is reported `unavailable`, never replaced. Any other value goes to `Ignored args`. §2 resolves all of this in code — do not re-derive it.
- `extra-advisor` (or `--extra-advisor`) → **EXTRA=on**: also run `pi` as an extra consultant, unless pi already is the consultant (then there is still one pi lane, reported `skipped (pi is the consultant)`). Optional model: `extra-advisor=<model>` (e.g. `extra-advisor=gemini-2.5-pro`, `extra-advisor=sonnet:high`) → passed to `pi --model`, also when pi is the consultant. Without a model, §2 picks pi's model by role from `pi --list-models`: as the consultant an OpenAI model first, then glm → qwen → kimi; as extra glm → qwen → kimi. It never falls back to pi's unpinned default.
  - **Independence check:** the value of an extra consultant is a *different* model family. Read `extraSameEngine` from `review.decision.json` (§6); when it is true, the extra lane adds little — say so in the report (section 9) and suggest `extra-advisor=<other-model>`.
- `timeout=<sec>` → per-attempt wall clock (`T`) for the consultant lanes and their refuter re-runs. Default `900`, clamped to `[30, 1800]`, always an integer. A lane that times out or fails transiently is **retried once**; a config error (bad auth, rejected schema, unknown model) is not. Each phase is bounded by **2×T** — §5 and §8 separately, so `sceptic=strict` can take up to ~4×T in the worst case. A lane whose attempts all fail is reported `degraded (…)` and **its findings are lost**, so the cost of setting this too low is a whole source silently dropped from the review, not a slower review. The lanes run in parallel, so a higher ceiling costs nothing until something actually hangs. Measured: a codex consultant reading a small repository was still working at **600s**, so the old `240` default truncated ordinary runs.
- `p2=<mode>` → how P2 is presented in the report (§9). `grouped` (default) — up to 7 individually, the rest rolled up by theme. `full` — every P2 individually. `off` — omit the P2 body, but keep the count in `Totals` and one summary line, because a suppressed section must still be visibly suppressed.
- `out=<path>` → where the report file goes. A value ending in `/`, or naming an existing directory, is treated as a directory and the default filename is used inside it; anything else is the exact file path. Default: `<INVOKE>/.reviews/review-<slug>-<YYYY-MM-DD>.md` (`INVOKE` from §1).
- `no-file` → do not write a report file at all, terminal output only. With this flag the review performs **zero** writes anywhere on disk (`$WD` under `/tmp` aside) — no run archive either.
- `archive=off` → do not keep the run archive. By default §9 copies a bounded, private snapshot of `$WD` (diff, each source's prompt and raw output, an event log) to `<INVOKE>/.reviews/<run-id>/`, and only when git confirms `.reviews/` is ignored. `out=` moves the report, never the archive.
- `lang=<language>` → output language for the review: any language, given as a code or a name; English by default. A value you cannot read as a language goes to `Ignored args`. Code identifiers, paths, and technical terms always stay in their original form. Pass the chosen language to the dimension agents and into the consultant brief.

## 1. Resolve diff and context
Work dir **outside the repo**: `WD=$(mktemp -d)` (in `/tmp`, not under the repo — otherwise it pollutes `git status`). Right after it, print `work dir: <WD>` (a dead run is salvaged from it with `archive-run.mjs finish --wd <WD>`) and record the invoking directory as `INVOKE=<abs path of the cwd>`. Shell state does not persist between calls, so keep `WD` and `INVOKE` as **literals** from here on; a later `cd` must move neither.

**PR mode:**
- gh repo resolution: a full URL is self-describing. For `owner/repo#N` and `#N` pass `-R <owner/repo>` (otherwise `gh pr diff` from a non-git dir fails with "not a git repository"). Bare `#N` without owner/repo: try to derive the repo from the cwd git remote, else stop and ask for `owner/repo#N` or a URL.
- `gh pr diff <target> [-R …] > "$WD/diff.patch"`
- `gh pr view <target> [-R …] --json title,baseRefName,headRefName,url` (metadata only, **no** `body`).
- `REPO` = the current clone if it matches the PR; otherwise **diff-only mode** (note it in the report).
- **If `gh` is unavailable/unauthenticated** (first parse `owner/repo` + `N` from the URL or `owner/repo#N`):
  1. If a local clone of that repo exists: `git fetch <remote> pull/<N>/head` then `git diff <baseRef>...FETCH_HEAD > "$WD/diff.patch"`.
  2. Else, for a public repository, fetch the diff over HTTP: `curl -fsSL "https://github.com/<owner>/<repo>/pull/<N>.diff" > "$WD/diff.patch"`. This path is **diff-only** — note it. Never read a token from the environment to reach a private repository: that is what `gh` and a local clone are for.
  3. If none works (a private repository without `gh` or a clone, bare `#N` with no remote, or no network) → stop and report that PR mode needs `gh` or a local clone.

**Uncommitted mode:**
- `git diff HEAD > "$WD/diff.patch"`; untracked via `git status --porcelain`.
- Empty and no untracked → print "No changes to review" and **stop**.
- `REPO` = the root of the current repository.

## 2. Pre-flight health-check
Select the consultants in **one** foreground call:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/run-lane.mjs" select --wd <literal WD> [--consultant <x>] [--extra [--extra-model <m>]]
```
`--consultant` from `consultant=`, `--extra` from `extra-advisor`, `--extra-model` from `extra-advisor=<model>`. It writes `$WD/consultants.json`: `{"lanes":[{"name","brief","refuterBrief","model","skip","skipReason"}],"extraNote","reason"}`. Read it; §4, §5 and §8 copy its values **literally**. A lane with `skip` is not started (don't wait for the timeout); it keeps its line with `--skip`. Without `extra-advisor` there is no extra lane.

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

**3.4. Assign a tier** (the `deep`/`minimal` flags override auto-classification):
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
- `dims=` overrides the lanes at any tier (`arch` is the alias for `dims=+architecture`); without it, tests are added only when test files are present in the diff.
- `extra-advisor` adds pi as an extra consultant at any tier (including T1; not T0 — T0 runs nothing).
- the sceptic pass (section 8) runs **strict by default** on any P0/P1 findings — `sceptic=basic` drops the refuter vote, `sceptic=off` (alias `no-sceptic`) disables it.
- **T0:** do not run agents/consultants. Do a light pass yourself (Opus): quickly check the non-code for gross errors (broken JSON/YAML, obvious config typos) and emit a SHORT report with the classification and a note "no code-impacting changes — full panel skipped (override: `deep`)". Don't stay silent about what was skipped.

Record `TIER`, `DIMS`, and the consultant set — they drive section 5. Show the classification to the user before launching (one line), and write it with the Write tool to `$WD/triage.json` as `{"tier": "T0..T3", "dims": [...], "basis": "<short>"}`.

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
          "owner"
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

Run only what the tier assigns (section 3.5): T0 — neither agents nor consultants (short report); T1 — impact agent + consultant; T2/T3 — assigned agents + consultant. `dims=`/`arch`, `extra-advisor`, `sceptic=off|basic`, `timeout=` and `deep`/`minimal` apply as modifiers (§0). The tests dimension is added automatically whenever the diff contains test files — `dims=+tests` forces it when it does not.

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
Pass each one: the path to `$WD/diff.patch`, `REPO`, the mode (PR/uncommitted/diff-only), the output language (from `lang`), and **`TIER` with an exploration budget** — T1/T2 means "the diff plus its nearest context and direct consumers; do not sweep the repository", T3 means the full protocol. Each agent explores independently (that is what buys source independence), so an unbounded brief multiplies the same repo walk by the number of lanes. Their structured output is the Claude lane's share of the findings, each already carrying its `dimension`. The **same P0/P1 evidence bar and P2 admission bar** are built into each agent prompt, so every lane is held to one standard — the consultant brief in §4 is not a stricter rule for the consultants alone, and the standalone `/arch-review`-style commands keep the bar even without an orchestrator.

**Consultant lanes** (every entry of `consultants.json` `lanes`) — through the lane helper `scripts/run-lane.mjs`, never by calling `codex`/`pi`/`claude` directly. The helper owns the read-only flags, the per-attempt timeout, the single retry and killing each attempt's process group; it writes `$WD/<name>.status.json` per lane and, only on success, the canonical `$WD/<name>.json`.

Make this **ONE Bash call with `run_in_background: true`**: one shell owns every node process, so `wait` is valid and `decide` runs after all of them. Separate background calls (one per lane) are still forbidden — nothing would own all the processes. Shell state does not persist between calls, so write every value (`$WD`, `$REPO`, `T`, each lane's fields) as a **literal**.
```bash
WD=/tmp/tmp.XXXX REPO=/abs/repo T=900   # literals; T from timeout=<sec>
H="${CLAUDE_PLUGIN_ROOT}/scripts/run-lane.mjs"
# one line per consultants.json lane, its name/brief/model/skip/skipReason copied literally
node "$H" run <name> --wd "$WD" --name <name> --repo "$REPO" --brief-file "$WD/<brief>" --timeout "$T" [--model <model>] [--skip <skip> --skip-reason "<skipReason>"] &
wait
node "$H" decide --wd "$WD" --phase review --lanes <name>[,<name>…]   # every lane name, in consultants.json order
```
- Add `--model` only when the lane's `model` is non-null, and `--skip … --skip-reason …` only when its `skip` is.
- **While the call runs**, launch the dimension agents (above). On the call's completion notice, read `$WD/review.decision.json`.
- **No notice?** Poll the literal path in a foreground call, e.g. `timeout 540 sh -c 'until [ -f /tmp/tmp.XXXX/review.decision.json ]; do sleep 5; done'`, repeated until **2×T + 60 s** in total (count whole seconds). Pass **`timeout: 600000`** on that Bash call: the tool's default is 120 s, which would kill the poll long before `timeout 540`. If the file is still missing, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/run-lane.mjs" decide --wd <literal WD> --phase review --lanes <same list>` yourself: a lane without a status is then reported `failed: helper error (no status written)`, never as zero findings. `review.decision.json` is write-once — whichever `decide` runs first wins, a later one leaves it as is — so read the file after your `decide`, whoever wrote it.
- claude-cli read-only enforcement is the flag set the helper passes (`--safe-mode --restricted --tools Read,Grep,Glob`, no MCP servers, no session persistence, `--add-dir $WD`); it runs in `$REPO` on the user's Claude quota.
- pi read-only enforcement is the **toolset** the helper passes (`--tools read,grep,find,ls --no-mcp` — no `edit`, `write` or `bash`, and no MCP server tools, which `--tools` alone keeps; pi has no sandbox flag), plus `--no-extensions --no-session --no-skills --no-prompt-templates --no-context-files --no-approve`, so no extension code, saved session, skills or context files. A model whose provider only an extension supplies (e.g. `claude-bridge`) is therefore not available, even as an explicit `extra-advisor=<model>`. It runs in `$REPO`, so give the diff by its **absolute** `$WD/diff.patch` path in the brief.
- pi has no output-schema flag. In `$WD/brief-pi.md` add: "Output the findings strictly as a JSON array per the schema between the markers `===FINDINGS_START===` and `===FINDINGS_END===`" — the helper takes the last such block and treats its absence as `unparseable`.

## 6. Collect and normalize
- dimension agents: take their structured findings, normalize to the common schema (the `dimension` field is known from the agent), `source = claude`.
- consultants: read `$WD/review.decision.json` — `lanes.<name>` is each lane's status (`status`, `display`, `attempts[]`, and for pi `provider`/`model`); top-level `family.<name>` is the lane's model family (`openai`, `anthropic`, `zhipu`, … or `unknown`) and top-level `independence.<name>` is `model | context | unknown`; plus `allExternalDown`, `extraSameEngine` and `refuters` (keyed `<name>-refuter`). Read findings from `$WD/<name>.json` **only when that lane's `status` is `ok`**; the file exists only then. A missing or unreadable file is never "zero findings" — the lane's `display` says why (`degraded (timeout; failed: <reason>)`, `failed: <config reason>`, `failed: helper error (…)`). Treat `null` in `line`/`failure_scenario`/`suggested_fix` as "not provided". A `failed: <reason>` without retry is a config bug to fix (bad auth, rejected schema), not a clean review.
- pi: `$WD/pi.json` is already parsed from the markers. Report pi's actual `provider`/`model` from its status in section 9 and apply the independence check from section 0.
- claude-cli: with `--json-schema` a refusal comes back as empty findings, so an empty `claude-cli` result is weak evidence — covered by the context-independent note (§9), never a clean bill.
- Tag every finding with `source` (`claude`/`codex`/`pi`/`claude-cli`) and `dimension`, and **preserve `owner`** when the reporting lane set it — normalizing it away is what turns the §7 owner rule into a no-op.
- Write the Claude lane's findings **as received, before any merging**, with the Write tool to `$WD/claude-findings.json` as `{"findings": [...]}` (each with its `dimension`, `owner` kept).
- **Floor case:** when `allExternalDown` is true (no external lane ended `ok*`) — build the report from the Claude dimension agents only, with the §9 top warning `> **Single-source review (Claude only):** …`; do not abort.

## 7. Consensus synthesis (you are the arbiter)
- **You do NOT author findings yourself.** Findings come only from the independent dimension agents + the consultants — each a separate context. You merge/dedup/rank; you never grade your own review — the sceptic pass (§8) is run by a separate independent verifier to avoid confirmation bias.
- **Dedup** overlapping findings by (file, line neighborhood, meaning) — across sources AND across dimensions (the same problem may surface as both impact and quality — merge, keep the more precise `dimension`). When in doubt, don't merge; mark as related.
- **Agreement badge** `[claude|codex|pi|claude-cli]` — who found it (merged duplicates combine their sources). The token names the **lane, not the model**: every dimension agent is `source = claude` whichever model it runs on (§6), so two Claude lanes reporting the same problem merge into a single `[claude]` — cross-dimension overlap never inflates the badge.
- **Agreement counts families, not tokens.** The number of sources is the number of distinct **known** families among the badge's lanes: `claude` is `anthropic`, every other lane's family is `family.<name>` in `review.decision.json` (§6), and a lane whose family is `unknown` adds nothing. So `[claude|claude-cli]` is **one** source (both `anthropic`, `independence.claude-cli` is `context`), and `[claude|codex|pi]` with codex and pi both on `openai` is **two** sources, not three. The single-source rule (below, §8, §9) uses the same count.
- **`owner:` tags.** A lane may report something outside its own protocol and tag it `owner: <lane>` (e.g. quality flags a probable bug it cannot trace to consumers). If that lane ran, normal dedup applies — merge and keep the more precise `dimension`. **If that lane did not run in this review** (architecture is absent at T2; `dims=` can narrow the panel further), the finding is *ungraded*: keep the reporter's severity, do not demote it for being out-of-lane, and mark it in the report as `owner lane not in this run — ungraded`. A finding must never be lost because the lane that owns it was skipped.
- Assign the **final severity** per the impact rubric (the decision is yours; source agreement influences confidence).
- Keep minority/disputed findings (single source, i.e. one family) with an annotation; never drop them silently.
- Give **every** merged finding a string id (`F1`, `F2`, …) in report order, and write the merged list with the Write tool to `$WD/synthesis.json` as `{"findings": [{"id": "F1", …}, …]}` (each with `source`, `dimension`, final `severity`). These ids are the only ids of this run — §8 reuses them and never renumbers.

## 8. Sceptic pass (STRICT by default; `sceptic=basic` softens it, `sceptic=off` skips it) — INDEPENDENT verification
To avoid confirmation bias, the sceptic pass is performed by an **independent verifier agent with fresh context** — NOT by you (the arbiter), and NOT by the agent that produced the finding. You only apply its verdicts.
- Collect the P0/P1 findings (P2 isn't worth verifying), each with its id from `$WD/synthesis.json` — in both modes, never renumbered. Spawn `finding-verifier` via Task (batched — pass the whole list in one call; split into a few calls if large), giving it ONLY: the path to `$WD/diff.patch`, `REPO`, and the findings (id, title, `file:line`, severity, dimension, claimed `failure_scenario`, source, rationale). Do NOT pass your synthesis reasoning. Namespaced fallback: `consensus-review:finding-verifier`.
- When `finding-verifier` returns, write its JSON verdict array verbatim to `$WD/verifier.verdicts.json` **only if** it returned a usable JSON array; otherwise write nothing. If you split it into several calls, concatenate the verdict arrays from all of them into that one file (still only usable arrays). This holds in `basic` and `strict` alike.
- **Strict — the default.** Additionally enlist the consultants as refuters and take a **majority vote** per finding. `sceptic=basic` skips this paragraph entirely and applies the verifier verdicts as-is.
  - Write the P0/P1 ids (the `synthesis.json` ids above) as a JSON array to `$WD/ids.json`, and a refuter brief ("argue why each finding is NOT real", the same findings fields the verifier gets, the output language) to each `$WD/<refuterBrief>` of a lane whose refuter is marked `run`: `$WD/refuter-brief.md` for the schema lanes, `$WD/refuter-brief-pi.md` for pi — the same text plus "Output the verdicts strictly as a JSON array of `{id, verdict: confirmed|unconfirmed|refuted, evidence}` between the markers `===VERDICTS_START===` and `===VERDICTS_END===`".
  - Which refuters run is already decided in `review.decision.json` (`refuters`) — do not re-derive it. The helper reads it, runs a refuter marked `run`, and writes the recorded `skipped (…)` status for the rest without starting anything. Run them with the **same backgrounded-call protocol as §5** (one `run_in_background: true` call with literal values; without a completion notice, the bounded literal-path poll — here on each `$WD/<name>-refuter.status.json` — up to 2×T + 60 s, each poll call with `timeout: 600000`, then `decide` regardless), launching `finding-verifier` while it runs:
    ```bash
    WD=/tmp/tmp.XXXX REPO=/abs/repo T=900   # literals
    H="${CLAUDE_PLUGIN_ROOT}/scripts/run-lane.mjs"
    # one line per consultants.json lane, as in §5 (same --model); --schema only for the schema lanes (codex, claude-cli)
    node "$H" run <name> --wd "$WD" --name <name>-refuter --repo "$REPO" --brief-file "$WD/<refuterBrief>" --timeout "$T" \
      --from-decision "$WD/review.decision.json" [--schema "${CLAUDE_PLUGIN_ROOT}/contracts/verdict.schema.json"] \
      --require-key verdicts --ids-file "$WD/ids.json" [--model <model>] &
    wait
    ```
  - Once `$WD/verifier.verdicts.json` is written (or `finding-verifier` returned nothing usable) and the refuter statuses exist (or the bounded poll above has run out), always run in a foreground call `node "${CLAUDE_PLUGIN_ROOT}/scripts/run-lane.mjs" decide --wd <literal WD> --phase sceptic --lanes <name>-refuter[,<name>-refuter…]` (every lane), then read `$WD/sceptic.decision.json`: `perFinding.<id>.decision` is the verdict to apply, `perFinding.<id>.voters` reads `n of m`, `perFinding.<id>.noVote` names the voters that cast no vote on it, `verifier` is `ok | missing | invalid`, `excluded` maps a refuter left out of the ballot to its reason, and `voteMode` is `strict`, `strict → basic`, or `strict → basic (no independent refuter)`. Every id from `$WD/ids.json` has a decision; a finding with no vote at all is `unconfirmed`. Without a verifier vote a finding is `unconfirmed` — a refuter never decides alone. Report `verifier=missing|invalid` in section 9. If the decision carries `error` (e.g. `failed: helper error (no ids)`), apply none of it: fall back to the verifier's verdicts as in `sceptic=basic` and say so in section 9 — and if the verifier output is also missing or invalid, every P0/P1 is `unconfirmed` (a P0 goes to **Unverified — needs confirmation**).
  - **The vote is lenient by design.** Only voters that returned a valid verdict for a finding count: a strict majority decides, a **tie is `unconfirmed`** (so with the default two voters a finding needs both to survive as stated; with three, 2 of 3 confirm), and a lone vote applies as-is only when it is the verifier's. A refuter that failed or timed out casts no vote rather than a negative one — an infrastructure failure must not remove a real P0. When no refuter voted at all, `voteMode` is `strict → basic` and the verifier's verdicts apply; when every refuter was skipped or excluded for family reasons, it is `strict → basic (no independent refuter)`. Say which in section 9.
- Apply the verdicts:
  - `refuted` → drop (P1/P2, logged) or, for P0, move to **Unverified — needs confirmation** with the refutation reason.
  - `unconfirmed` → downgrade; single-source-unconfirmed → **Unconfirmed (single-source)**; a P0 → **Unverified — needs confirmation** (not counted in Totals P0).
  - `confirmed` → keep; mark `survived skeptic` and cite the verifier's evidence.
- **P0 is never silently dropped** — it is either `confirmed` (stays P0, with evidence) or moved to the Unverified bucket with a reason.
- **No silent drops:** log every drop/downgrade/move together with the verifier verdict.

## 9. Report
Write the report in the selected output language (`lang`, default English). Sort P0→P1→P2 (within a tier — by agreement desc, then dimension/file). Print to the terminal **and** save the file, unless `no-file` was given (terminal only, zero writes). Destination: `out=<path>` when set (directory value → default filename inside it; otherwise the exact path), else `<INVOKE>/.reviews/review-<slug>-<YYYY-MM-DD>.md` (create the dir; for the remote-PR diff-only case write to the invoking repo's `.reviews/`). State the destination — or "not written (`no-file`)" — in the last line of the terminal output.

**Archive — on the file branch only, never with `no-file`.** Before writing the report, run in a foreground call, with the literals from §1 and the final report path:
```bash
cd <literal INVOKE> && node "${CLAUDE_PLUGIN_ROOT}/scripts/archive-run.mjs" finish --wd <literal WD> --report <final report path> --args-json '<flags JSON>'   # add --off with archive=off
```
`<flags JSON>` is one object: `{"target": "<PR ref | uncommitted>", "mode": "PR|uncommitted|diff-only", "sceptic": "off|basic|strict", "tier": "T0..T3", "dims": [...], "extra": true|false, "timeout": <T>, "lang": "<lang>"}`.
It prints one JSON line and exits 0 either way: `{"dir":"…"}` → `Archive: <dir relative to INVOKE>`; `{"skipped":"…"}` → `Archive: not written (<reason>)`. A failed or unparseable call is `Archive: not written (<what happened>)`; the report is still written and the review's outcome is unchanged. Put that `Archive:` line in the header block and append it to the last terminal line. With `no-file` there is no `Archive:` line.

Format:
```
# Consensus Review — <target: PR #N url | uncommitted in <repo>>
<only when review.decision.json has allExternalDown: true (never at T0, where no consultant runs):>
> **Single-source review (Claude only):** <name>=<display> for each lane. No external model cross-checked these findings.
<only when every ok external lane has `independence.<name>` = "context" in review.decision.json:>
> Consultant is the same model family as the panel (claude-cli): context-independent only.

base→head: <…> | date: <…> | consultant: <name> (<reason>) | sceptic: STRICT/BASIC/OFF | extra-advisor: ON (pi, <provider/model>)/OFF/<extraNote> | timeout: <sec> | p2: <grouped|full|off> | lang: <language>
Ignored args: <unrecognized or overridden tokens, or "none">
Classification: tier=<T0..T3> | effective code: <~N lines / M files> | non-code excluded: <K lines (.bru/lock/docs)> | blast: <isolated|local|wide> | basis: <short>
Dimensions: <architecture? quality impact tests?>  (applied / skipped with reason)
Sources: <each lane's `display`, refuters included> — e.g. codex=ok (retried: unparseable), pi=degraded (timeout; failed: rate limit), claude-cli=ok, claude-cli-refuter=skipped (same-family), claude=ok
Code graph: <codegraph|graphify|none> (used for navigation/blast-radius)
Archive: <.reviews/<run-id> | not written (<reason>)>   <omitted with no-file>
Totals: P0=<n> P1=<n> P2=<n>

## P0
### <title>  `file:line`  [claude|codex|pi|claude-cli]  (dimension/category)<, survived skeptic>
<rationale>
**Fix:** <suggested_fix>
...
## P1
## P2
<Per `p2=<mode>` (§0):
 - `grouped` (default): up to 7 entries individually, highest confidence first; everything beyond that grouped by theme, one line each —
   `- <theme> ×<N> — file:line, file:line, … (confidence: <low|medium|high>)`. `low`-confidence P2s always go to the grouped lines, never the individual list.
 - `full`: every P2 individually, no grouping.
 - `off`: no entries at all, just one line — `<N> P2 findings suppressed (p2=off)`.
 In every mode this is presentation only: `Totals` keeps the true count, and in `grouped` every file still appears. Nothing is dropped silently.>

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
<dropped P1/P2 + downgrades, each with the reason — only when sceptic is on (basic or strict)>

## Source availability
<one line per external lane (refuters included) with its attempts from `attempts[]`, e.g.
 `codex: degraded — attempt 1: timeout (900s); attempt 2: failed: stream disconnected (412s)`,
 `codex-refuter: ok (retried: failed) — attempt 1: failed: rate limit (35s); attempt 2: ok (610s)`;
 skipped/unavailable lanes with their reason; diff-only mode, etc.
 strict sceptic: `voteMode: strict | strict → basic | strict → basic (no independent refuter)`, `verifier` when it is not `ok`, each `excluded` refuter with its reason, and the voters per finding — `F1: 2 of 2 voters`, `F3: 1 of 2 voters (no vote: codex-refuter)`.
 with a pi lane: pi's resolved provider/model; with `extraSameEngine: true`, a note that the extra lane is the same family as the consultant and adds little independence — suggest extra-advisor=<other-model>>
```

## Hard rules
- **Read-only:** do not edit code, commit, push, comment on the PR, or run fixes. The only writes are the report file (`.reviews/` by default, or `out=<path>`) and its private run archive (`<INVOKE>/.reviews/<run-id>/`, unless `archive=off`) — and with `no-file` there is no write at all.
- Working files only in `$WD` (mktemp outside the repo).
- Never "lose" a source or dimension silently — skips and unavailability always appear in the report ("Dimension summary" and "Source availability" sections).
