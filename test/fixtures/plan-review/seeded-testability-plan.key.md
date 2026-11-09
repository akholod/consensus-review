# Key: `seeded-testability-plan.md`

Run doc-only (`/consensus-review:plan-review test/fixtures/plan-review/seeded-testability-plan.md`
in a directory that holds only the plan). Dimension: `testability`.

A seed is **hit** when the run raises a `testability` finding, or an Open question for the author,
that names its line and states its gap. TC must not be flagged as untestable.

| Id | Line(s) | Text | Gap a hit must state |
|---|---|---|---|
| T1 | 14 | "Search returns results quickly and sorted correctly." | "quickly" has no number and "sorted correctly" has no order or key, so neither can be checked |
| T2 | 20 | "Add a unit test that checks the member discount is applied." | no input or expected value (which order, which member, what price after the discount, from which rule) |
| T3 | 15 | "Orders over the free-shipping threshold ship free." | the criterion gives no number and says "over", while the rule two lines below says "at or above 5000": the boundary's inclusivity contradicts the documented rule, so an implementer cannot tell whether 5000 ships free |
| T4 | 21–22 (with 25) | "VAT is `vatFor(cents)`, a pure function in `src/tax.js`; cover its rounding with an E2E checkout test." | the level is wrong: a rounding rule in a pure function is observed by a unit test, which is cheaper; E2E also costs the 10-minute CI budget (line 25) |
| TC | 16–17 | "`quoteShipping(5000)` → `0`, `quoteShipping(4999)` → `499` (rule: `docs/pricing.md` §2 …); unit" | clean: literal values, a named source, the boundary on both sides, a stated level. Flagging it as untestable is `false` |

Report-only gate (plan §Eval procedure, PR): at least 3 of T1–T4 hit, TC unflagged.
