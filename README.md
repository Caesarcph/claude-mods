# chenp-mods

Two Claude Code mods, packed as one marketplace.

| Mod | What it does |
|---|---|
| [prompt-upgrade](prompt-upgrade) | Turns a rough prompt into a clear one in the chat. It asks a few multiple-choice questions in the same dialog plan mode uses, rewrites the prompt with your answers, and sends it for you. Commands: `/better <prompt>`, `/better on`/`off`, `/better history`. |
| [auto-model](auto-model) | Picks the model and thinking effort for each turn from how hard the prompt looks. Commands: `/auto-model`, `on`, `off`, `set`, `reset`, `try`. |

## Install

Run this at the prompt of a terminal Claude Code session, answer `y` to add the marketplace, then choose a scope:

```bash
/plugin install prompt-upgrade --marketplace Caesarcph/claude-mods
```

```bash
/plugin install auto-model --marketplace Caesarcph/claude-mods
```

## prompt-upgrade

1. Type `/better 帮我写个登录页` (or turn on `/better on` and just type prompts as usual).
2. Up to three questions pop up one after another, each with options and an "Other" box to type your own answer. Press Esc to cancel: your prompt goes back into the prompt box and nothing is sent.
3. The upgraded prompt is sent as your message. A line above it says how much it grew and what was added.

The questions see the last few messages of the conversation, so they don't ask what was just discussed. Questions and the rewrite follow the language of your prompt.

Options (in `/config`): `questionModel` (default `haiku`), `rewriteModel` (default `sonnet`), `maxQuestions` (1-4, default 3), and `review` (`send` by default; `review` adds one last dialog to send, edit, or send your original).

In automatic mode these are sent as typed: slash commands, `!` shell lines, short replies such as "yes" or "继续", prompts with attachments or `@` mentions, prompts over 150 words, and anything typed while Claude is working. Start a prompt with `>` to send it as typed.

## Notes

- `auto-model` is on by default, and `prompt-upgrade`'s automatic mode is off until you run `/better on`.
- Model aliases (`haiku`, `sonnet`, `opus`) are turned into full model IDs before they are sent.
- `auto-model`'s optional model judge (`judge: model`) uses `judgeModel`, `haiku` by default.
- Settings made with `/auto-model set` are stored on each machine, not in this repository.
