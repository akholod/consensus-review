# Releasing

## Gates

1. **CI green** — `node --test`, `node scripts/gen-contracts.mjs --check`, `node scripts/lint-prompts.mjs`, and plugin validation, on Node 20/22/24. Deterministic; no model calls.
2. **Adapter compatibility** — `node scripts/compat-check.mjs`. This one makes a real `claude -p` call, so it is not in CI. It proves the live CLI still returns the envelope `adapter.mjs` parses. **No release without a green run.**

   The probe itself lives in `scripts/lib/probe.mjs`, shared with `scripts/doctor.mjs`. One set of probes, two entry points: the check that gates a release and the check a user runs cannot drift apart and start disagreeing about what a working setup looks like.
3. **Version bump** in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.

## Why the compatibility check is a release gate and not a CI job

Putting an authenticated, billed, network-dependent call into the project's first CI pipeline buys flake, not confidence. The failure it guards against — the CLI changing its output shape — happens on CLI upgrades, not on our commits, so a release-time check catches it at the only moment it matters.

## Compatibility record

Record each release's result here.

| Date | Plugin version | claude CLI | compat-check |
|---|---|---|---|
| 2026-08-18 | 0.7.0 (pre-loop-review) | 2.1.234 | fixtures captured; adapter interpretation pinned |
| 2026-08-18 | 0.8.0 | 2.1.234 | green — all 5 checks passed |
| 2026-08-19 | 0.8.2 | 2.1.235 | green — all 6 checks passed, after the probe was rewritten (see below) |
| 2026-08-19 | 0.8.3 | 2.1.235 | green — all 6 checks passed |
| 2026-08-19 | 0.9.0 | 2.1.235 | green — all 6 checks passed |

## 2026-08-19 — why the probe changed

Against CLI **2.1.235** the original probe failed. It asked for a canned
`{"findings":[],"cells":[]}` with no code attached, and the model refused: that is a request to
fabricate a clean verdict for a review it was never given.

**The adapter was not at fault, and the envelope contract was intact** — the envelope parsed and
every `usage` and cost check passed. Only the payload-shape checks failed, and they failed on
content, not on shape. The adapter classified the refusal correctly, which is the behaviour the
`refusal` fixture exists to pin.

The probe now sends the production discovery prompt with a small real diff, so it exercises the
path the runtime actually uses instead of a degenerate one. A gate that does not exercise the
production path cannot vouch for it. It also gained a `cells` check, which the runtime depends on
and the old probe never asserted.
