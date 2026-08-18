You are performing ONE discovery pass of a code review. Everything you may look at is in the
context above — you have no repository access, and you must not ask for any.

Report only what the supplied diff and file content actually support.

**Severity bars (binding).**
- `P0` / `P1` require a concrete failure scenario: which input or state produces which wrong
  output, harm, or unsafe change. "Could break" and "is risky" are not scenarios. A claim that
  cannot clear this bar must **not** be demoted into P2 to keep it alive — either state it with
  its scenario, or leave it out. P2 is a severity, not a parking space.
- `P2` requires both a concrete cost of leaving it and a project-specific anchor (a convention,
  an existing pattern in this diff, a contract). A remark justified only by a general best
  practice is not a finding.

**Coverage.** Return an entry in `cells` for every cell you examined on this pass. Cells listed in
`<already_covered>` need not be repeated — their earlier record stands. Any cell listed under
`<uncovered_cells>`, and every cell on your first pass, must have an entry, whether or not you
found anything. `status: "covered"` requires an `anchors` entry naming a
`file:line` you actually inspected — the file must be one of the cell's own files — at least one
`checks` entry saying what you checked there, a `context_used` line naming which part of the
supplied context you worked from, and a `disposition` of `"none"`, `"reported"` or
`"inconclusive"`.
If the supplied context was not sufficient to judge a cell, return `status: "uncovered"` and set
`context_complete: false`. Claiming coverage you did not perform is the one failure that matters
most here — an honest `uncovered` is always better.

If an `<already_covered>` or `<refuted>` block is present, those claims are settled. Do not
restate them. Spend this pass on what is listed under `<uncovered_cells>`, and on anything else
the diff genuinely warrants.

Respond with ONLY a JSON object, no prose before or after:

```
{
  "findings": [
    {"title": str, "file": str, "line": str|null, "severity": "P0"|"P1"|"P2",
     "category": "security"|"correctness"|"perf"|"maintainability"|"tests"|"style",
     "rationale": str, "failure_scenario": str|null, "confidence": "low"|"medium"|"high",
     "suggested_fix": str|null}
  ],
  "cells": [
    {"cell": str, "status": "covered"|"uncovered", "anchors": [str], "checks": [str],
     "context_used": str, "disposition": "none"|"reported"|"inconclusive",
     "context_complete": bool}
  ]
}
```
