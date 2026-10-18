# Install consensus-review: instructions for an AI agent

You are an AI coding agent. The user asked you to install and set up
consensus-review, a Claude Code plugin for code review: a panel of
Claude reviewers plus the `codex` CLI as an independent consultant
(`/consensus-review`), and a sequential multi-pass review
(`/loop-review`).

Follow the steps in order. A step marked **ASK** needs the user's answer:
ask, wait for the reply, never guess it. Run every command yourself unless
the step says the user has to do it. Never read, print or copy auth files
or API keys (`~/.codex/auth.json`, `gh` tokens, `~/.claude` credentials).

Humans: the same steps work by hand. Back to the [README](../README.md).

## 1. Check Claude Code and Node

```sh
claude --version
node --version
claude plugin list
```

- `claude` missing: the user has to install Claude Code first and come
  back.
- Node below 20: `/consensus-review` still works, `/loop-review` and
  the doctor do not. Tell the user; offer to continue without them.
- `claude plugin list` already shows `consensus-review@crv`: the plugin
  is installed. Run `claude plugin update consensus-review@crv`, then go
  to step 3.

## 2. Install the plugin

```sh
claude plugin marketplace add akholod/consensus-review
claude plugin install consensus-review@crv
```

The marketplace is called `crv`, the plugin `consensus-review`. If the
user keeps copies of these commands or agents in `~/.claude/commands` or
`~/.claude/agents`, tell them: the copies and the plugin will both show
up, and the copies should go.

## 3. Check the external tools

Nothing below is bundled with the plugin. Check what is there:

```sh
codex --version
gh --version && gh auth status
codegraph --version
pi --version
```

What each one adds, and what a review does without it:

| Tool        | Adds                                                     | Without it                                                    |
| ----------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| `codex`     | the independent consultant and the sceptic's second vote | every review is Claude-only; the report says so               |
| `gh`        | pull requests by number or URL                           | the diff is fetched by URL; private repos need `GITHUB_TOKEN` |
| `codegraph` | fast, precise blast radius (`impact`, `callers`)         | reviewers trace consumers with grep: slower, less precise     |
| `pi`        | a second consultant, only with the `extra-advisor` flag  | that flag has nothing to add                                  |

`graphify` is also detected and used if present; it is optional
(`uv tool install graphifyy`, with two `y`s).

## 4. ASK: which tools to add

Show the user the table above for the tools that are missing and ask
which ones to install. Recommend `codex` (a review without it has a
single source) and `codegraph`. Install only what they pick:

```sh
npm install -g @openai/codex            # then the user runs: codex login
npm install -g @colbymchenry/codegraph  # then, in each repo: codegraph init
npm install -g @earendil-works/pi-coding-agent
```

`gh`: install it with the system package manager (`apt install gh`,
`brew install gh`), then the user runs `gh auth login`.

The logins (`codex login`, `gh auth login`) open a browser. Ask the user
to run them and wait. You cannot do them for the user.

`codegraph init` builds an index inside the repository it runs in. Run
it only in a repository the user names, and only if they agree. The
plugin never builds a graph itself; it uses one when it finds one.

## 5. Keep reports out of git

Reports go to `.reviews/` in the reviewed repository. In each repository
the user wants to review, check:

```sh
git check-ignore .reviews || echo "not ignored"
```

If it is not ignored, suggest adding `.reviews/` to `.gitignore`.
Otherwise the next review picks up the last report as an untracked
change.

## 6. Verify

The plugin loads in new Claude Code sessions. In a running session the
user types `/reload-plugins` first.

Then run the doctor from inside the repository to be reviewed. If you are
Claude Code, invoke the `consensus-review:doctor` skill; otherwise ask the
user to type `/consensus-review:doctor` (plain `/doctor` is Claude Code's
own). It makes two small live model calls (about a minute); adding
`offline` skips them.

Every line is `PASS`, `WARN`, `FAIL` or `SKIP`, and each non-pass line
says what it does to a review. Fix every `FAIL` (see
[troubleshooting.md](troubleshooting.md)) and run it again. `WARN` lines
are fine to leave if the user agrees: they mean fewer sources, not a
broken review.

## 7. Report

Tell the user, briefly:

- what you installed, and which tools are still missing and what that
  costs a review;
- the doctor's result;
- how to start: `/consensus-review` for uncommitted changes,
  `/consensus-review #<PR>` for a pull request, `/loop-review` for the
  sequential review;
- undo: `claude plugin uninstall consensus-review@crv` and
  `claude plugin marketplace remove crv`.
