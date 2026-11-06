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
| `arch-reviewer`          | `opus`                    | `medium`   | boundaries and long-term complexity                                       |
| `quality-reviewer`       | `sonnet`                  | `high`     | conventions and duplication: matching against the repo's own precedent    |
| `test-reviewer`          | `sonnet`                  | `high`     | the same kind of work, for tests                                          |
| `finding-verifier`       | `opus`                    | `high`     | see below                                                                 |
| codex consultant         | codex's configured model  | codex's    | the plugin passes no `--model`                                            |
| pi consultant or extra   | picked by role, or `pi-model=<model>` | pi's | see [How pi picks its model](#how-pi-picks-its-model)                  |
| claude-cli consultant    | `sonnet`                  | CLI default | a separate `claude -p`; same family as the panel                       |
| `/loop-review` passes    | `sonnet`, or `--model=<m>` | CLI default | every pass and the verification use the same model                     |

**Use Opus for the session.** The arbiter is whatever model the session
runs, and it sets the final severity of every finding. `/model` picks it.

**The verifier stays on Opus on purpose.** A weaker reviewer misses
findings; a weaker sceptic lets false ones through. One confirmed false
P0 costs more trust than one missed bug costs coverage.

**The effort is pinned in the frontmatter.** `impact-reviewer` and the
verifier run at `high`: Opus 5.5 defaults to `medium` where Opus 5 ran at
`high`, so without the pin the `opus` alias moving to a new release would
quietly make reviews shallower. `arch-reviewer` runs at `medium`: it gives
a verdict on boundaries, not a trace through call sites. The Sonnet
agents run at `high`, because below `high` is not worth it on Sonnet. The
pin also means a session at `xhigh` does not raise these agents. The
environment variable `CLAUDE_CODE_EFFORT_LEVEL` overrides it.

**`models=` and `effort=` override per role for one run** (a flag, or a
key in a [profile](consensus-review.md#profiles)), for example
`models=verifier:fable effort=impact:xhigh`; unlisted roles keep the
table above. The arbiter is the session model (`/model`) and no setting
changes it. The values are requests: Claude Code may reject a model or
effort, or substitute another model. A Task rejected for its override is
re-run once without its overrides, and the report names the override as
dropped (`models override dropped (<role>)`) and shows the requested
label, never a model the Task result does not confirm. Per-invocation
`effort` on subagents needs Claude Code 2.1.292 or later; an older CLI may
ignore it, and `/consensus-review:doctor` warns.

The Opus/Sonnet split is a judgement, not a measurement: no behavioural
eval yet shows what it does to recall.

## The consultants need a different model

A consultant is only worth its cost if it is a different model from the
ones already on the panel. Three reviews by one model are one opinion.

- **codex** runs on OpenAI's models, so it is different by default. Its
  model is set in codex's own config, not here.
- **pi** is pinned to a model of another family, chosen by role (below).
  Pick your own with `pi-model=<model>`. The report prints pi's
  resolved `provider/model` and flags a same-family collision.
- **claude-cli** is a different process but the same model family as the
  panel: context independence only.

## How pi picks its model

pi's model comes from `pi --no-extensions --list-models` (a local
catalog), by role. pi runs without extensions, skills, context files or a
saved session, so the catalog leaves out providers that only an extension
supplies (such as `claude-bridge`); an explicit `pi-model=<model>`
naming one is not available in read-only mode.

- **pi is the consultant**: an OpenAI model first, then glm → qwen → kimi
  via `opencode-go`.
- **pi is the extra**: glm → qwen → kimi, so it differs from codex and
  from the Claude panel.
- Claude models are never picked automatically, and pi's default model is
  never used unpinned. With no usable model, an automatic pi is skipped
  (the cascade moves on); a forced or extra pi is `unavailable`.
- **"Newest"** within a family: drop names matching `flash`, `free` or
  `mini`, then take the highest by numeric-aware name order.
- `pi-model=<model>` overrides all of this.
- A listed model is not necessarily one you are logged in to.

### Model families

Independence and voting use one family per lane. codex is `openai` and
claude-cli is `anthropic`. A pi lane is classified from its
`provider model` string by the first match in this order, anthropic first:

| Family     | Matches                                  |
| ---------- | ---------------------------------------- |
| `anthropic`| `claude`, `anthropic`                    |
| `openai`   | `openai`, `gpt`, `codex`, `o1`..`o9`     |
| `google`   | `gemini`, `google`                       |
| `deepseek` | `deepseek`                               |
| `qwen`     | `qwen`                                   |
| `mistral`  | `mistral`                                |
| `meta`     | `llama`, `meta`                          |
| `xai`      | `grok`, `xai`                            |
| `zhipu`    | `glm`, `zhipu`                           |
| `moonshot` | `kimi`, `moonshot`                       |

Only positive matches count. Anything else is `unknown`: it adds no
independent source and never votes.

## Changing models

- **Arbiter**: `/model` in your session.
- **`/loop-review`**: `--model=<m>`, for example `--model=opus`.
- **pi**: `pi-model=<model>`; see above.
- **codex**: codex's own configuration.
- **The agents, for one run**: `models=<role:model,…>` and
  `effort=<role:effort,…>`, as a flag or in a profile.
- **The agents, by default**: their model and effort are in the frontmatter of
  `agents/*.md`. A plugin's files are replaced on update, so changing
  them means a fork, not a local edit.
