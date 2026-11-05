---
description: Architectural impact review of a change (diff-scoped) via the arch-reviewer agent
argument-hint: "[<PR-url|git-range|path|empty=working tree>] [lang=<language>]"
---

Run the `arch-reviewer` subagent via Task and return its full structured result without abridgement.

- `subagent_type: "arch-reviewer"` (when installed as a plugin and the bare name does not resolve — `consensus-review:arch-reviewer`)
- Pass the scope from the args below into the prompt. Empty → current working tree (`git diff HEAD` + untracked); a PR URL/ref → that PR; git range / path / glob — as given.
- Before dispatching, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/lenses.mjs" standalone --dim architecture [--target "<scope>"]` (pass `--target` with the scope from the args, everything but `lang=…`, verbatim, whenever it is non-empty). If its JSON has a non-null `lensFile`, add `Project lenses file: <lensFile>` to the agent prompt. Otherwise (null, an error, or no output) dispatch exactly as before.
- Pass the output language if `lang=<language>` is present: any language, as a code or a name (default English).
- This is a read-only review: do not edit or commit anything. Stop after returning the result.

Scope: $ARGUMENTS
