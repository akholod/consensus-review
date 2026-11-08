# Plan: cache consultant probe results

## Goal
`select` probes codex, pi and claude-cli on every run. Cache the probe
result for a run so a retry does not probe again.

## Steps
1. In `scripts/run-lane.mjs`, write the probe result to `$WD/probe.json`
   after `select`.
2. Re-run the lane from the cache: call
   `node scripts/run-lane.mjs run codex --wd "$WD" --foo cached`.
3. Add a `scripts/settings.mjs` key `foo` that turns the cache off.
4. Document the cache in `docs/consensus-review.md`.

## Constraints
- This change adds no settings; the cache is always on.
- Errors are handled appropriately.
- Keep the diff small; no new dependencies.

## Acceptance
- A second `select` in the same `$WD` makes no probe call.
- `npm run check:all` stays green.

## Rollout
Ship in the next minor release.
