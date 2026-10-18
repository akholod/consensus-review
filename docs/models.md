# Models

Which model each part of a review runs on, and how to change it. Back to
the [README](../README.md).

The plugin names model **families** (`opus`, `sonnet`), never versions.
Claude Code resolves them to the current release, so a new model is
picked up without a plugin update, and a review can change behaviour
without one too. `/consensus-review:doctor` prints what each agent runs on.

## Who runs on what

| Part                     | Model                     | Effort     | Why                                                                       |
| ------------------------ | ------------------------- | ---------- | ------------------------------------------------------------------------- |
| arbiter                  | your session's model      | session    | it is the session running `/consensus-review`                             |
| `impact-reviewer`        | `opus`                    | `high`     | tracing call sites and regressions is deep reasoning                      |
| `arch-reviewer`          | `opus`                    | `high`     | boundaries and long-term complexity                                       |
| `quality-reviewer`       | `sonnet`                  | session    | conventions and duplication: matching against the repo's own precedent    |
| `test-reviewer`          | `sonnet`                  | session    | the same kind of work, for tests                                          |
| `finding-verifier`       | `opus`                    | `high`     | see below                                                                 |
| codex consultant         | codex's configured model  | codex's    | the plugin passes no `--model`                                            |
| pi consultant            | pi's default, or `extra-advisor=<model>` | pi's | only with `extra-advisor`                                         |
| `/loop-review` passes    | `sonnet`, or `--model=<m>` | CLI default | every pass and the verification use the same model                     |

**Use Opus for the session.** The arbiter is whatever model the session
runs, and it sets the final severity of every finding. `/model` picks it.

**The verifier stays on Opus on purpose.** A weaker reviewer misses
findings; a weaker sceptic lets false ones through. One confirmed false
P0 costs more trust than one missed bug costs coverage.

**The effort is pinned at `high` on the Opus agents** because Opus 5.5
defaults to `medium` where Opus 5 ran at `high`. Without the pin, the
`opus` alias moving to a new release would quietly make reviews
shallower. The pin also means a session at `xhigh` does not raise these
agents above `high`. The environment variable `CLAUDE_CODE_EFFORT_LEVEL`
overrides it.

The Opus/Sonnet split is a judgement, not a measurement: no behavioural
eval yet shows what it does to recall.

## The consultants need a different model

A consultant is only worth its cost if it is a different model from the
ones already on the panel. Three reviews by one model are one opinion.

- **codex** runs on OpenAI's models, so it is different by default. Its
  model is set in codex's own config, not here.
- **pi** often defaults to the same engine codex uses (`openai-codex`,
  `gpt-5.x`). Then the extra lane mostly echoes codex. Pick another
  model with `extra-advisor=<model>` (for example `extra-advisor=sonnet:high`
  or `extra-advisor=gemini-2.5-pro`), or set another default in
  `~/.pi/agent/settings.json`. The report prints pi's resolved
  `provider/model` and flags the collision.

## Changing models

- **Arbiter**: `/model` in your session.
- **`/loop-review`**: `--model=<m>`, for example `--model=opus`.
- **pi**: `extra-advisor=<model>`.
- **codex**: codex's own configuration.
- **The agents**: their model and effort are in the frontmatter of
  `agents/*.md`. A plugin's files are replaced on update, so changing
  them means a fork, not a local edit.
