---
description: Maintainability and code-quality review via the quality-reviewer agent
argument-hint: "[<PR-url|git-range|path|empty=working tree>] [lang=en|ua]"
---

Run the `quality-reviewer` subagent via Task and return its full structured result without abridgement.

- `subagent_type: "quality-reviewer"` (when installed as a plugin and the bare name does not resolve — `consensus-review:quality-reviewer`)
- Pass the scope from the args below into the prompt. Empty → current working tree (`git diff HEAD` + untracked); a PR URL/ref → that PR; git range / path / glob — as given.
- Pass the output language if `lang=en|ua` is present (default English).
- This is a read-only review: do not edit or commit anything. Stop after returning the result.

Scope: $ARGUMENTS
