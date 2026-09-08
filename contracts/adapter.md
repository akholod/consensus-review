# RunnerAdapter contract

```
run({ prompt, systemPrefix, model, timeoutMs, cwd, denied, bin, requireKey })
  -> { state, payload, usage, detail, ms, modelId, runnerId }
buildArgs({ prompt, systemPrefix, model, denied }) -> string[]   // pure; the argv above
```

`state` is one of `ok | malformed | truncated | refused | timeout | failed`. Only `ok` may contribute findings; every other value forces the run to a non-`CLEAN` terminal state.

`requireKey` names the array the payload must contain — `findings` for a discovery pass, `verdicts` for verification. Without it the adapter would classify a well-formed verification response as malformed.

`usage` carries `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` and `cost_usd`. `interpret({ rc, stdout, timedOut, requireKey })` is exported separately and is pure, so the recorded fixtures drive it directly.

## Verified CLI behaviour

Captured against **claude 2.1.234 (Claude Code)**. Re-run `node scripts/compat-check.mjs` before every release.

- Invocation: `claude --disallowed-tools "<list>" --strict-mcp-config --mcp-config '{"mcpServers":{}}' [--append-system-prompt "<prefix>"] --output-format json --model <m> -p "<prompt>"`.
- `systemPrefix` carries the run-invariant part of the request (the diff and its context) and MUST NOT be repeated inside `prompt`. The `-p` message is a **single prompt-cache block**: a prefix placed inside it is invalidated by its own varying tail, so every pass re-uploads the diff. The saving scales with prefix size — measured −41% billed input on a synthetic 28k-token prefix, −5.7% on a real 2k one. See `docs/loop-review-measurements.md` §US-004, including what actually dominates the bill.
- `--append-system-prompt` takes exactly one value and does not swallow the following flag, but is kept before `-p` with the other flags.
- `--disallowed-tools` and `--allowed-tools` are **variadic** and swallow a following positional argument; they must precede `-p`.
- `--allowed-tools` does **not** act as an exclusive allowlist and does not restrict tool use. See `docs/loop-review-measurements.md` §US-003.
- Isolation needs **both** halves. `--disallowed-tools` covers built-in tools only; MCP tools stay on offer and execute whenever the reviewed machine allowlists them (measured: an allowlisted `codegraph_explore`, which returns verbatim source, ran with `permission_denials: []`). `NO_MCP` — `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` — is therefore not optional and is always emitted. See §US-005.
- Success envelope fields used: `result` (string payload), `usage.{input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens}`, `total_cost_usd`, `stop_reason`, `is_error`, `subtype`, `num_turns`, `permission_denials`.
- `stop_reason: "max_tokens"` indicates truncation.
- A refusal is returned as `is_error: false`, `subtype: "success"`, exit 0, with prose in `result`. Payload-shape validation is mandatory; exit status is not sufficient.
- On timeout the process is killed and **no** envelope reaches stdout — an absent envelope must never be read as "zero findings".
- `permission_denials` is empty even when tools were used, so it is not evidence of isolation; `num_turns > 1` is the usable signal.
