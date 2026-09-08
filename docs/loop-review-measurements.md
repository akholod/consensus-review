# loop-review — measurements

## Phase 0 spike (2026-08-18)

Environment: `claude` CLI **2.1.234 (Claude Code)**, model `sonnet`, node v24.16.0, Linux.

---

### US-002 — cross-process prompt caching: **REFUTED — superseded by US-004 (2026-09-08)**

*Hypothesis (plan §1.6):* Anthropic prompt caching matches on request prefixes rather than on a session, so two sequential `claude -p` invocations sharing a byte-identical static prefix may reuse one cache entry.

*Method:* one byte-identical ~8k-token static prefix (`commands/consensus-review.md` plus a header), three **separate** `claude -p --output-format json` processes, differing only in a short trailing instruction.

| run | input | cache_creation | cache_read | cost |
|---|---|---|---|---|
| A | 2 | 31399 | 30501 | $0.19998 |
| B | 2 | 31864 | 30501 | $0.20303 |
| C | 2 | 31399 | 30501 | $0.19907 |

*Result:* **REFUTED.** `cache_read_input_tokens` is identical (30501) in all three runs — that figure is the CLI's own static system/tool preamble, which is cached independently of our content. `cache_creation_input_tokens` stays at ~31.4k on **every** run, i.e. the supplied static prefix is re-written to cache each time and never read back. There is no cross-process reuse of the review context.

*Consequence, per the plan's own fallback:* keep process isolation and the accepted pass minima, and absorb the cost. Do **not** switch to a shared conversation. Recorded cost is ~**$0.20 per pass** (`total_cost_usd` as the CLI reports it — the API-price valuation of the tokens, which is a bill on an API plan and usage-limit consumption on a subscription) for an 8k-token static context with negligible output — so the per-pass context cost is real and multiplies by the pass count. This is the dominant cost term and Phase 3 must measure it against `/consensus-review`.

> **This conclusion was wrong, and the error is instructive.** The runs differed "only in a short trailing instruction" — and that is exactly the condition under which the prefix *cannot* be reused, because the whole `-p` message is a single cache block. The experiment therefore measured the block boundary, not the absence of cross-process caching. Repeated with a **byte-identical** message, the same CLI reuses the entire request across separate processes at a 100% hit rate. The right conclusion is not "caching does not cross processes" but "the invariant part has to live in a different block from the varying part". See US-004.

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

### US-004 — the prefix/message split: **CONFIRMED, but small at real prefix sizes** (2026-09-08)

Environment: `claude` CLI **2.1.263 (Claude Code)**, model `sonnet`, Linux. Re-examines US-002, which was measured on 2.1.234.

*Hypothesis:* US-002 did not refute cross-process caching; it hit the cache-block boundary. A `claude -p` request is cached in blocks, the whole `-p` message is one block, so a varying tail invalidates the static prefix sharing that message.

*Method A — is a request reusable at all across processes?* Byte-identical message, separate processes, stable cwd.

| call | input | cache_creation | cache_read | hit |
|---|---|---|---|---|
| 1 (cold) | 61,174 | 46,073 | 15,099 | 24.7% |
| 2–6 | 61,174 | 0 | 61,172 | **100.0%** |

Cross-process reuse is total when the request does not change. **US-002's conclusion was wrong**: its runs differed "only in a short trailing instruction", which is precisely the condition that invalidates the block. Its constant `cache_read` was the CLI's own preamble — a floor, not a ceiling.

*Method B — synthetic, ~28k-token prefix, 4 passes with a growing negative-space tail.* `billed_in` values input-token equivalents at the published multipliers (1h write ×2.0, read ×0.1).

| | hit | billed_in |
|---|---|---|
| prefix inside `-p` | 22.5% | 384,901 |
| prefix in `--append-system-prompt` | 56.8% | **225,213** (−41%) |

*Method C — the same comparison on a REAL loop-review context.* Four-file JS repo, 2 files changed. `staticPrefix` measured at **1,957 tokens**; `discovery.md` 664.

| | create | read | hit | billed_in |
|---|---|---|---|---|
| prefix inside `-p` | 83,072 | 77,837 | 48.4% | 173,928 |
| prefix in `--append-system-prompt` | 77,710 | 85,252 | 52.3% | **163,945** (−5.7%) |

Full-run A/B on the same diff, 3 passes + verification, 6 calls each: `total_cost_usd` **$0.9968 → $0.9711** (−2.6%), same terminal state.

*Result:* **CONFIRMED, and adopted** — but the saving is proportional to prefix size, and real prefixes are small. The synthetic −41% is what a 28k-token prefix buys; a 2k prefix buys −5.7%, which is within run-to-run noise. The change is kept because it costs nothing, is free of behavioural risk, and pays exactly where reviews get expensive: a large PR whose diff and original-file context run to tens of thousands of tokens.

**Do not cite the −41% figure as loop-review's saving.** It is the mechanism's ceiling, not its typical effect.

*What actually dominates the bill.* At ~38k input tokens on a cold pass with a 2k prefix, **~33k is the CLI's own preamble** — its system prompt, built-in tool schemas, MCP tool schemas (~3.7k, see US-005) and the machine's global `CLAUDE.md` (~3.3k here). That is re-created on every pass whose message changed, and no flag removes the built-in tool schemas. The review context is a minor term; the per-call overhead multiplied by the pass count is the cost driver.

*Secondary — the work directory.* `bin/loop-review.mjs` creates its work dir with `mkdtempSync`, so cwd differs on every CLI invocation, costing ~5.4k of cache read per call (15,101 → 9,724). Every pass of one run shares the dir, so this only affects re-runs; left alone rather than trading a predictable `/tmp` path for it.

*Corroboration from production transcripts:* 291 real `loop-review` spawn sessions aggregated to a 56.6% hit rate, a 1:1.30 write:read ratio, and 94% of billed input spent on cache **writes**.

---

### US-005 — MCP tools defeat pass isolation: **CONFIRMED, fixed** (2026-09-08)

*Finding:* `--disallowed-tools` names **built-in** tools only. MCP tools are offered to a discovery pass regardless, and whether they execute depends on the reviewed machine's `permissions.allow` — not on anything this runtime controls.

*Method:* a pass carrying the full `DENIED_TOOLS` list was asked to call an MCP tool, on a machine whose `~/.claude/settings.json` allowlists `mcp__codegraph__*`.

| invocation | num_turns | permission_denials | outcome |
|---|---|---|---|
| `--disallowed-tools "<list>"` (an MCP tool NOT allowlisted) | 3 | `[{tool_name: "mcp__exa__web_search_exa", …}]` | blocked by the permission system |
| `--disallowed-tools "<list>"` (`mcp__codegraph__*` allowlisted) | 4 | `[]` | **ran** — the pass reported `codegraph_explore confirms no .codegraph/ index` |
| `+ --strict-mcp-config --mcp-config '{"mcpServers":{}}'` | 2 | `[]` | the tool does not exist |

`codegraph_explore` returns verbatim repository source. In an indexed repository, a pass that is supposed to see nothing but its prebuilt context could read the tree through it — which would make its coverage records claims about material the design says it never saw. The unallowlisted case being blocked is not a defence: it is the reviewed machine's setting, and it is free to change.

*Consequence:* `adapter.buildArgs` now always spawns with `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` (`NO_MCP`). Isolation becomes structural rather than permission-dependent. Side effects, both wanted: ~3.7k fewer tokens per call (33,162 → 29,453 on the probe) and no MCP server startup per spawn. `readonly.test.mjs` pins it.

*Note on `permission_denials`:* it is populated when the permission system blocks a tool, so US-001's "empty even when tools were used" holds only for tools that were *allowed*. It still cannot be used as evidence of isolation — an empty list is exactly what a successful bypass produces.

---

### US-006 — the two fixes together, measured end to end (2026-09-08)

Three calls with a fixed real context (`staticPrefix` 1,095 tokens) and fixed tails, so nothing but the flags differs.

| | cache_creation | cache_read | hit | billed_in | wall |
|---|---|---|---|---|---|
| before (prefix in `-p`, MCP live) | 80,779 | 153,100 | 65.5% | 176,868 | 247s |
| after (prefix out of band, no MCP) | 62,295 | 76,296 | 55.1% | **132,220** | 231s |

**−25.2% billed input**, and slightly faster.

*Read the hit rate with care.* It **fell**, from 65.5% to 55.1%, while the bill dropped a quarter. A cache write is billed at 1.25–2.0× base input and a read at 0.1×, so the ratio between them is not a cost measure. The number that moved is `cache_creation`: 80,779 → 62,295. Report the two counters, never the percentage alone — which is why `report.mjs` prints `read / written` and not just the hit rate.

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
