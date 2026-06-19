---
description: Review of a change and its impact on adjacent parts via the impact-reviewer agent
argument-hint: "[<PR-url|empty=working tree>] [lang=en|ua]"
---

Run the `impact-reviewer` subagent via Task and return its full structured result without abridgement (starting with the one-line verdict).

- `subagent_type: "impact-reviewer"` (when installed as a plugin and the bare name does not resolve — `consensus-review:impact-reviewer`)
- Pass the scope from the args below into the prompt. Empty → current working tree (staged + unstaged); a PR URL/ref → that PR (all commits against base).
- Pass the output language if `lang=en|ua` is present (default English).
- This is a read-only review: do not edit or commit anything. Stop after returning the result.

Scope: $ARGUMENTS
