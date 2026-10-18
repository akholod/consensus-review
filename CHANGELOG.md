# Changelog

Full notes for each release: [GitHub releases](https://github.com/akholod/consensus-review/releases).

## 0.12.0

Ready for Anthropic's plugin directory, and reports in any language.

- **`lang=` takes any language**, as a code or a name. It used to know
  only English, Ukrainian and Russian.
- **No token is read from your environment.** Without `gh`, a private
  pull request used to be fetched from api.github.com with your
  `GITHUB_TOKEN`; it now needs `gh` or a local clone. Public pull
  requests are still fetched by URL.
- **The README lists everything the plugin runs and where code goes**:
  codex and pi to their providers, `claude -p` to Anthropic, `gh` and
  `curl` to GitHub, the doctor's probes.
- **A listing icon** at `.claude-plugin/icon.png`, and the demo GIF
  shrunk under the directory's 5 MiB per-file limit.

## 0.11.0

Structured output for `/loop-review`, effort pinned for the Opus agents,
and docs ready for publishing.

- **Large diffs no longer fail every `/loop-review` pass.** The review
  context went to the CLI as one argument, and Linux caps one argument
  at 128 KB; a 24-file diff made a 530 KB one and every pass failed
  before reaching the model. It now goes as a file.
- **`/loop-review` asks the CLI for validated JSON** (`--json-schema`)
  instead of digging the payload out of the reply text.
- **The Opus agents run at `high` effort.** Opus 5.5 defaults to
  `medium`; without the pin, reviews would have become shallower when
  the `opus` alias moved. The doctor shows each agent's effort.
- **Docs rewritten for publishing**: a shorter README, an install guide
  an agent can follow, and separate pages for each command, models and
  troubleshooting. Design notes moved to `docs/design/`.
- **A demo in the README**, recorded from a real review with VHS;
  `assets/demo/record.sh` re-records it.
- **Published to npm** as `consensus-review`. Installing through the
  Claude Code marketplace is unchanged.

## 0.10.0

- **Closed a hole in `/loop-review` pass isolation.** `--disallowed-tools`
  covers built-in tools only, so an MCP tool the reviewed machine had
  allowed (such as `codegraph_explore`, which returns source) could run
  inside a pass. Passes now start with no MCP servers at all.
- **The review context is cached across passes.** It used to sit in the
  per-pass message, which is one cache block, so every pass uploaded the
  diff again. Measured: billed input down 25% on a real context.
- The report prints cache reads and writes separately; the hit rate
  alone is not a cost signal.

## 0.9.1

- A consultant you never installed is a `WARN` in the doctor, not a
  `FAIL`. One that is installed and broken is still a `FAIL`.

## 0.9.0

- **`/consensus-review:doctor`**: checks consultants, code graph,
  contracts and workspace, and runs two live probes. Every problem line
  says what it silently does to a review.

## 0.8.3

- **Quality and tests run on Sonnet**; impact, architecture and the
  verifier stay on Opus.
- **Consultant timeout raised from 240 to 900 seconds.** A lane that
  times out loses its findings, and codex was measured still working at
  600 seconds on a small repository.
- The agreement badge is `[claude|codex|pi]`: it names the lane, not the
  model.

## 0.8.2

- **Deterministic eval layer**: prompt templates are generated from one
  payload schema, the runtime is checked against it, and a prompt lint
  guards agent frontmatter and the read-only guarantee. No model calls;
  runs in CI.

## 0.8.1

- Tests run on Node 20 again (no behaviour change).

## 0.8.0

- **`/loop-review`**: the sequential strategy. One context, several
  passes that never see each other's reasoning, evidence per risk cell,
  and a `CLEAN` that a failed or under-covered run cannot produce.
- Both commands share one finding schema and one set of severity bars.

## 0.7.0

Rolls up 0.5.0 and 0.6.0.

- **Critical fix: the codex lane failed on every run in 0.4.0.** OpenAI's
  strict structured outputs rejected the schema. Upgrade.
- **The sceptic is `strict` by default**: verifier plus consultant
  refuters with a majority vote. `sceptic=off|basic|strict`.
- **Triage proportional to risk**: high-risk paths (migrations, auth,
  manifests) get the full panel at any size; small isolated edits can
  stay at T1.
- Every flag accepts a leading `--`. `codex-only` was removed.

## 0.4.0

- `opencode` replaced by [`pi`](https://pi.dev), and the second
  consultant is opt-in with `extra-advisor[=<model>]`. Default panel:
  codex alone.

## 0.3.0

- First release: Opus arbiter, codex and opencode consultants, four
  dimensions, triage tiers T0 to T3, P0 to P2, an independent sceptic,
  code-graph awareness, and the single-dimension commands.
