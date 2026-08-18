# Severity bars — shared contract

Consumed by `/consensus-review` and `/loop-review`. Change it here, nowhere else.

## P0/P1 evidence bar

Every P0 and P1 must name a concrete failure scenario: which input or state produces which wrong output, harm, or unsafe change. "Could break", "is risky" and "harder to maintain" are not scenarios. A finding that cannot clear this bar is reported as an explicit hypothesis under **Unverified**, never demoted into P2.

## P2 admission bar

A P2 must name **both** the concrete cost of leaving it **and** a project-specific anchor — a documented convention, an existing pattern in this repo, or a contract. A remark justified only by a general best practice is not a finding; drop it. Collapse repeats: one P2 covering N sites, not N entries.

## Severity meanings

- `P0` — blocks merge: a reachable defect causing data loss, security exposure, incorrect money/permission handling, or a broken production contract.
- `P1` — should be fixed before or soon after merge: a real defect or a maintainability problem with a named future cost.
- `P2` — worth doing at a convenient moment; must still clear the admission bar.

## Verification vocabulary

`finding-verifier` emits exactly three verdicts: `confirmed`, `unconfirmed`, `refuted`, plus an optional `suggested_severity`.

`reduced` is a **normalized** outcome, not a verifier output: it is `confirmed` accompanied by a `suggested_severity` lower than the reported severity. Consumers derive it; the verifier never emits it.
