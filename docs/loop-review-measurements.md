# loop-review — measurements

## Phase 0 spike (2026-08-18)

Environment: `claude` CLI **2.1.234 (Claude Code)**, model `sonnet`, node v24.16.0, Linux.

---

### US-002 — cross-process prompt caching: **REFUTED**

*Hypothesis (plan §1.6):* Anthropic prompt caching matches on request prefixes rather than on a session, so two sequential `claude -p` invocations sharing a byte-identical static prefix may reuse one cache entry.

*Method:* one byte-identical ~8k-token static prefix (`commands/consensus-review.md` plus a header), three **separate** `claude -p --output-format json` processes, differing only in a short trailing instruction.

| run | input | cache_creation | cache_read | cost |
|---|---|---|---|---|
| A | 2 | 31399 | 30501 | $0.19998 |
| B | 2 | 31864 | 30501 | $0.20303 |
| C | 2 | 31399 | 30501 | $0.19907 |

*Result:* **REFUTED.** `cache_read_input_tokens` is identical (30501) in all three runs — that figure is the CLI's own static system/tool preamble, which is cached independently of our content. `cache_creation_input_tokens` stays at ~31.4k on **every** run, i.e. the supplied static prefix is re-written to cache each time and never read back. There is no cross-process reuse of the review context.

*Consequence, per the plan's own fallback:* keep process isolation and the accepted pass minima, and absorb the cost. Do **not** switch to a shared conversation. Recorded cost is ~**$0.20 per pass** (`total_cost_usd` as the CLI reports it — the API-price valuation of the tokens, which is a bill on an API plan and usage-limit consumption on a subscription) for an 8k-token static context with negligible output — so the per-pass context cost is real and multiplies by the pass count. This is the dominant cost term and Phase 3 must measure it against `/consensus-review`.

---

### US-003 — isolation: **CONFIRMED, but not by the mechanism the plan named**

The plan asserted `--allowed-tools` can hard-restrict a pass to the prebuilt context. That is **false**.

| invocation | outcome |
|---|---|
| `--allowed-tools ""` | **Not restricted** — the pass read `README.md` and reported its heading (`num_turns: 2`) |
| `--allowed-tools "TodoWrite"` | **Not restricted** — still read `README.md` (`num_turns: 2`) |
| `--disallowed-tools "Read,Grep,Glob,Bash,Task,WebFetch,WebSearch,Edit,Write,NotebookEdit"` | **Restricted** — replied `NO_TOOL_ACCESS` |

`--allowed-tools` is permissive/additive, not an exclusive allowlist. **`--disallowed-tools` is the enforcement mechanism** and is what `adapter.mjs` uses. `permission_denials` stayed empty in every case, so it cannot be used as evidence of restriction — absence of denials does not mean absence of tool use; `num_turns > 1` is the usable signal.

Both flags are **variadic** (`<tools...>`) and will swallow a following positional prompt. They must be placed **before** `-p`.

---

### US-001 — adapter fixtures

Captured against CLI 2.1.234 into `test/fixtures/adapter/`: `ok`, `refusal`, `truncated`, `malformed`, `timeout`, `exit-nonzero`.

**Silent-failure finding:** a model refusal returns `is_error: false`, `subtype: "success"`, `stop_reason: "end_turn"` and exit code 0, carrying prose instead of a findings payload. Exit status and `is_error` are therefore **not** sufficient to detect a failed pass — the adapter must validate the payload shape. A refusal that reads as "success with zero findings" is precisely the path to a false `CLEAN`.

---

## Known limitations (as of the initial implementation)

Established by 13 adversarial review rounds against the runtime. These are inputs no real runner
produces; they are recorded rather than fixed, so the next person does not rediscover them.

- **A truncated diff section** carrying `diff --git`/`index`/`---`/`+++` but no hunk is treated as
  a metadata-only change rather than as an unparsed section. A genuinely mangled diff of that exact
  shape would review as "nothing to inspect here" instead of setting `unparsed`.
- **The bounded YAML instruction reader** rejects flow collections, tags, nulls and booleans where a
  string scalar is required, but still accepts implicitly-typed scalars — `123`, `1.5`, `.inf`,
  `2026-08-18` — as strings. A custom-instruction file relying on those types is read loosely.

Neither can produce a false `CLEAN` on output from the real `claude -p` runner; both would need a
hand-crafted diff or instruction file.
