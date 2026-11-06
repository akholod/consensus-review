---
description: Create, update or list the review profiles in .consensus-review/profiles/ (the only command that writes; it never commits)
argument-hint: "[<name> [key=value…]]"
---

Create, update, print or list the review profiles that `/consensus-review profile=<name>` applies.
All the work is done by `settings.mjs profile-edit`; you only pass the arguments through and print its output.

- No arguments: list the built-in defaults, then each profile with its layer (`user`, `repo`, `builtin`, and `shadowed by <layer>` when a higher one holds the name) and its keys. Read-only. User profiles (`~/.config/consensus-review/profiles/`) are edited by hand, never by this command.
- `<name>`: print `.consensus-review/profiles/<name>.md`.
- `<name> key=value…`: create or update that profile. `key=` (an empty value) removes the key. Only `key=value` pairs are accepted (no `deep`, `minimal` or `no-file`); the keys and values are those of `/consensus-review`.

Examples: `/consensus-review:profile quick depth=minimal dims=+quality sceptic=basic effort=verifier:medium,impact:medium`, `/consensus-review:profile release depth=deep extra=pi timeout=1200 models=verifier:fable effort=verifier:high,impact:high,architecture:high`.

## Steps

1. Run `git rev-parse --show-toplevel`. If it fails, print `not a git repository` and **stop**. Never paste the path it prints into a command; step 4 sets it again in the same call.
2. `D=$(mktemp -d)` (outside the repository). Keep `D` as a literal.
3. Write `$ARGUMENTS` **verbatim** (no paraphrase, no reordering, no quoting) with the Write tool to `$D/args.txt`. Never paste the arguments into a shell command.
4. Run, in one foreground call, with `D` in single quotes (a `'` in it is written as `'\''`):

   ```bash
   REPO=$(git rev-parse --show-toplevel) && node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs" profile-edit --repo "$REPO" --args-file '<literal D>/args.txt'
   ```

5. Print its stdout as is. On exit 2, print its stderr message and stop; nothing was written.

A written profile applies only once it is committed. The output ends with the exact `git add -- <path> && git commit -m '…' -- <path>` line; show it to the user and do not run it.

## Hard rules

- Writes only `.consensus-review/profiles/<name>.md`, and only through `settings.mjs profile-edit`; never commits, never stages, never edits anything else.
- Never hand-edit a profile file and never fix the helper's output: a value the helper rejects stops the command.
