---
description: Copy the built-in lenses and profiles (all, or the ones named) into .consensus-review/; never overwrites, never commits
argument-hint: "[name…]"
---

Copy the plugin's built-in lenses (`presets/lenses/*.md`) and profiles (`presets/profiles/*.md`) into `.consensus-review/lenses/` and `.consensus-review/profiles/`, as a starting point to edit and commit.
All the work is done by `settings.mjs init`; you only pass the arguments through and print its output.

- No arguments: copy every built-in lens and profile.
- `name…`: copy only those (a name may be a lens or a profile). An unknown name stops the command and lists the available ones; nothing is written.
- A file that already exists is never touched: the output says `exists, kept`.

## Steps

1. Run `git rev-parse --show-toplevel`. If it fails, print `not a git repository` and **stop**. Never paste the path it prints into a command; step 4 sets it again in the same call.
2. `D=$(mktemp -d)` (outside the repository). Keep `D` as a literal.
3. Write `$ARGUMENTS` **verbatim** (no paraphrase, no reordering, no quoting) with the Write tool to `$D/args.txt`. Never paste the arguments into a shell command.
4. Run, in one foreground call, with `D` in single quotes (a `'` in it is written as `'\''`):

   ```bash
   REPO=$(git rev-parse --show-toplevel) && node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs" init --repo "$REPO" --args-file '<literal D>/args.txt'
   ```

5. Print its stdout as is. On exit 2, print its stdout (the files already created, if any) and its stderr message, and stop.

The copies apply only once committed; until then a run that names a copied profile stops with `not tracked`. When anything was created, the output ends with the exact `git add -- <paths> && git commit -m '…' -- <paths>` line; show it to the user and do not run it.

## Hard rules

- Writes only new files under `.consensus-review/lenses/` and `.consensus-review/profiles/`, and only through `settings.mjs init`; never overwrites, never commits, never stages, never edits anything else.
- Never copy or hand-edit the files yourself and never fix the helper's output.
