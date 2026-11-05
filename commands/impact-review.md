---
description: Review of a change and its impact on adjacent parts via the impact-reviewer agent
argument-hint: "[<PR-url|empty=working tree>] [lang=<language>]"
---

Run the `impact-reviewer` subagent via Task and return its full structured result without abridgement (starting with the one-line verdict).

- `subagent_type: "impact-reviewer"` (when installed as a plugin and the bare name does not resolve — `consensus-review:impact-reviewer`)
- Pass the scope from the args below into the prompt. Empty → current working tree (staged + unstaged); a PR URL/ref → that PR (all commits against base).
- Before dispatching, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/lenses.mjs" standalone --dim impact [--target "<scope>"]` (pass `--target` with the scope from the args, everything but `lang=…`, verbatim, whenever it is non-empty). If its JSON has a non-null `lensFile`, add `Project lenses file: <lensFile>` to the agent prompt. Otherwise (null, an error, or no output) dispatch exactly as before.
- Pass the output language if `lang=<language>` is present: any language, as a code or a name (default English).
- This is a read-only review: do not edit or commit anything. Stop after returning the result.

Scope: $ARGUMENTS
