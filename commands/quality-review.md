---
description: Maintainability and code-quality review via the quality-reviewer agent
argument-hint: "[<PR-url …|git-range|path|empty=working tree>] [lang=<language>]"
---

Run the `quality-reviewer` subagent via Task and return its full structured result without abridgement.

- `subagent_type: "quality-reviewer"` (when installed as a plugin and the bare name does not resolve — `consensus-review:quality-reviewer`)
- Pass the scope from the args below into the prompt. Empty → current working tree (`git diff HEAD` + untracked); a PR URL/ref → that PR; git range / path / glob — as given.
- **A feature across repositories** — one review, one result, never one per repository or PR (unless the args ask for that):
  - Empty scope and the cwd is **not** in a git repository but holds several (a multi-repo folder) → `WD=$(mktemp -d)`, then `node "${CLAUDE_PLUGIN_ROOT}/scripts/workspace-diff.mjs" --wd "$WD" --root "$PWD"`.
  - Two or more PR refs (`owner/repo#N` or URLs; drop brackets, quotes and commas typed around each) → `WD=$(mktemp -d)`, then `node "${CLAUDE_PLUGIN_ROOT}/scripts/feature-diff.mjs" --wd "$WD" --invoke "$PWD" --target '<PR>' --target '<PR>' […] [--base '<branch>']`, with `--base` only when the args hold `base=<branch>` (used only when exactly one PR has a local checkout and `gh` is missing).
  - Exit 2 → print its stderr and stop. Otherwise pass the agent, instead of the scope: the diff file `$WD/diff.patch`, the repo dir (`root` from `$WD/workspace.json` / `$WD/feature.json`), that every diff path starts with its repository's directory (the `repos`/`prs` listed there), that git runs per repository (`git -C <root>/<path>`), and that a consumer of the change may live in another of these repositories. Skip the lenses call below (no single repository).
- Before dispatching, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/lenses.mjs" standalone --dim quality [--target "<scope>"]` (pass `--target` with the scope from the args, everything but `lang=…`, verbatim, whenever it is non-empty). If its JSON has a non-null `lensFile`, add `Project lenses file: <lensFile>` to the agent prompt. Otherwise (null, an error, or no output) dispatch exactly as before.
- Pass the output language if `lang=<language>` is present: any language, as a code or a name (default English).
- This is a read-only review: do not edit or commit anything. Stop after returning the result.

Scope: $ARGUMENTS
