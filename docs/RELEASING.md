# Releasing

## Gates

1. **CI green** — `node --test`, `node scripts/gen-contracts.mjs --check`, and plugin validation, on Node 20/22/24. Deterministic; no model calls.
2. **Adapter compatibility** — `node scripts/compat-check.mjs`. This one makes a real `claude -p` call, so it is not in CI. It proves the live CLI still returns the envelope `adapter.mjs` parses. **No release without a green run.**
3. **Version bump** in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.

## Why the compatibility check is a release gate and not a CI job

Putting an authenticated, billed, network-dependent call into the project's first CI pipeline buys flake, not confidence. The failure it guards against — the CLI changing its output shape — happens on CLI upgrades, not on our commits, so a release-time check catches it at the only moment it matters.

## Compatibility record

Record each release's result here.

| Date | Plugin version | claude CLI | compat-check |
|---|---|---|---|
| 2026-08-18 | 0.7.0 (pre-loop-review) | 2.1.234 | fixtures captured; adapter interpretation pinned |
| 2026-08-18 | 0.8.0 | 2.1.234 | green — all 5 checks passed |
