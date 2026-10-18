# consensus-review

[![CI](https://github.com/akholod/consensus-review/actions/workflows/ci.yml/badge.svg)](https://github.com/akholod/consensus-review/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/akholod/consensus-review)](https://github.com/akholod/consensus-review/releases)
[![npm](https://img.shields.io/npm/v/consensus-review)](https://www.npmjs.com/package/consensus-review)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/akholod/consensus-review/blob/main/LICENSE)

Code review for Claude Code that a second model has to agree with.

## The problem

Ask one model to review a change and you get one opinion. It locks onto
the first theme it notices, misses what sits beside it, and reports
guesses with the same confidence as bugs. A 2000-line dump of generated
configs gets the same expensive treatment as a 20-line change to auth.

## What it does

It reviews a pull request or your uncommitted changes in four
dimensions: architecture, quality, impact and tests. Two strategies:

- **`/consensus-review`** runs a panel in parallel: Claude reviewers for
  each dimension plus [`codex`](https://github.com/openai/codex) as an
  independent consultant. An arbiter merges what they found and shows
  who agreed on each finding.
- **`/loop-review`** builds the context once and reviews it in several
  passes. Each pass is told what is already covered, never why, so it
  looks somewhere else instead of repeating the last pass.

Both rank findings **P0** (blocker), **P1** (important) and **P2**
(minor), and both demand evidence: a P0 or P1 needs a concrete failure
scenario, or it is not a P0 or P1. Then a verifier with a fresh context,
which found nothing itself, tries to refute the serious findings before
you see them.

It never changes your code. The only file it writes is the report.

<p align="center">
  <img src="https://raw.githubusercontent.com/akholod/consensus-review/main/assets/demo.gif" alt="/consensus-review on a small change: impact, quality and tests agents plus codex run in parallel, a sceptic pass verifies the findings, and the report lists P0, P1 and P2 with failure scenarios" width="100%">
</p>

One command, three Claude reviewers and codex at once. A sceptic pass
tries to refute every serious finding before the report is written.

## Install

Paste this into Claude Code:

```text
Install and set up the consensus-review plugin by following https://raw.githubusercontent.com/akholod/consensus-review/main/docs/install.md
```

It installs the plugin, checks which consultants you have, and runs the
doctor to show what works.

Or by hand:

```text
/plugin marketplace add akholod/consensus-review
/plugin install consensus-review@crv
```

For development, add a local clone instead:
`/plugin marketplace add /path/to/consensus-review`.

Commands install namespaced (`/consensus-review:loop-review`); the bare
name works when no other command has it. The doctor always needs the
namespace, because Claude Code has a `/doctor` of its own.

Then run `/consensus-review:doctor`. For the full panel you also want `codex` (logged in), `gh` for
pull requests, and [`codegraph`](https://github.com/colbymchenry/codegraph)
for fast blast-radius. None of them is required; see
[docs/install.md](https://github.com/akholod/consensus-review/blob/main/docs/install.md) for what each one adds.

## How it looks in practice

```text
/consensus-review                     review uncommitted changes
/consensus-review #42                 review pull request 42
/consensus-review #42 deep lang=ua    full panel, report in Ukrainian
/loop-review --pr=42                  sequential review of the same PR
```

The report goes to the terminal and to `.reviews/`. Each finding carries
its location, severity, a failure scenario and an agreement badge such
as `[claude|codex]`. Its header says which sources ran, so a review that
lost its consultant says so instead of looking complete.

Small changes stay cheap: a triage step sizes the change and its blast
radius first, and a docs-only diff skips the panel entirely.

## Commands

| Command                    | Does                                                         |
| -------------------------- | ------------------------------------------------------------ |
| `/consensus-review`        | parallel panel with an arbiter, codex consultant and sceptic |
| `/loop-review`             | sequential passes with evidence per risk cell                |
| `/impact-review`           | correctness, regressions, security, the code around the diff |
| `/quality-review`          | conventions, duplication, AI slop, contracts                 |
| `/test-review`             | whether the tests catch realistic regressions                |
| `/arch-review`             | architectural impact of the change                           |
| `/architecture-audit`      | the whole project's architecture, not just a diff            |
| `/consensus-review:doctor` | what a broken setup would silently do to a review            |

The diff reviews take an empty scope (your working tree) or a pull
request: a URL, `owner/repo#N` or `#N` (`--pr=<n>` for `/loop-review`).
Flags: [docs/consensus-review.md](https://github.com/akholod/consensus-review/blob/main/docs/consensus-review.md) and
[docs/loop-review.md](https://github.com/akholod/consensus-review/blob/main/docs/loop-review.md).

## Which one to use

- You want to know whether a change is safe to merge, with several
  sources agreeing: `/consensus-review`.
- You want broad coverage at a lower cost per token, and a `CLEAN` you
  can trust: `/loop-review`. It can only report `CLEAN` when every pass
  succeeded and every risk cell was covered with evidence; that rule is
  in code, not in a prompt.
- You want one angle only: the single-dimension commands.

## Docs

- [Install](https://github.com/akholod/consensus-review/blob/main/docs/install.md): step by step, written for an agent but fine by hand.
- [consensus-review](https://github.com/akholod/consensus-review/blob/main/docs/consensus-review.md): flags, triage tiers, how findings are merged and verified.
- [loop-review](https://github.com/akholod/consensus-review/blob/main/docs/loop-review.md): passes, coverage cells, terminal states, cost.
- [Models](https://github.com/akholod/consensus-review/blob/main/docs/models.md): which model each part runs on, and how to change it.
- [Troubleshooting](https://github.com/akholod/consensus-review/blob/main/docs/troubleshooting.md): what the doctor's warnings mean.
- [Changelog](https://github.com/akholod/consensus-review/blob/main/CHANGELOG.md).

## What it runs and sends

Everything the plugin runs, and where your code goes:

- **Your code goes to the models you already use.** The Claude agents
  run in your Claude Code session. `/consensus-review` gives the diff
  and a short brief to `codex exec`, which runs in a read-only sandbox,
  reads files in your repository, and sends what it reads to OpenAI
  under your codex login. With `extra-advisor`, `pi` does the same with
  a read-only toolset and the provider pi is set up for. `/loop-review`
  runs `claude -p`, which sends the diff and its context to Anthropic.
- **GitHub, for pull requests.** `gh pr diff` and `gh pr view` read the
  PR. Without `gh`, a local clone is used, or for a public repository
  the diff is fetched with `curl` from github.com. No token is read from
  your environment.
- **Local tools.** `git` (read-only commands), and `codegraph` or
  `graphify` when they are installed.
- **The doctor** asks GitHub for the latest release and, unless run with
  `offline`, makes one small `claude -p` call and one `codex exec` call
  on a built-in sample diff.
- **Writes.** The report in `.reviews/` (or `out=<path>`, or nothing with
  `no-file`), and working files in a temp directory outside your
  repository.

The plugin has no telemetry and makes no other network call of its own.
The Claude agents run with your session's tools and permissions, minus
`Write` and `Edit`.

## Under the hood

The panel is plain Claude Code: commands and read-only subagents
(`disallowedTools: Write, Edit`). `/loop-review` is a small Node runtime
with no dependencies. Its passes run as separate `claude -p` processes
with every file, shell, web and MCP tool removed, so a pass sees only the
context it was given. Both strategies share one finding schema
(`contracts/finding.schema.json`) and one set of severity bars
(`contracts/severity-bars.md`); CI fails if a prompt drifts from them.

Design notes and measurements behind these choices live in
[docs/design/](https://github.com/akholod/consensus-review/tree/main/docs/design). Releasing: [docs/RELEASING.md](https://github.com/akholod/consensus-review/blob/main/docs/RELEASING.md).

## License

MIT, see [LICENSE](https://github.com/akholod/consensus-review/blob/main/LICENSE).

`codex`, `pi`, `codegraph` and `graphify` are separate tools. They are
not bundled; the plugin detects and calls them when you install them.
