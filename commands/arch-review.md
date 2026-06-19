---
description: Architectural impact review of a change (diff-scoped) via the arch-reviewer agent
argument-hint: "[<PR-url|git-range|path|empty=working tree>] [lang=en|ua]"
---

Run the `arch-reviewer` subagent via Task and return its full structured result without abridgement.

- `subagent_type: "arch-reviewer"` (when installed as a plugin and the bare name does not resolve — `consensus-review:arch-reviewer`)
- Pass the scope from the args below into the prompt. Empty → current working tree (`git diff HEAD` + untracked); a PR URL/ref → that PR; git range / path / glob — as given.
- Pass the output language if `lang=en|ua` is present (default English).
- This is a read-only review: do not edit or commit anything. Stop after returning the result.

Scope: $ARGUMENTS
