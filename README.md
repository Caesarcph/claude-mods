# chenp-mods

**English** · [简体中文](README.zh-CN.md)

Two Claude Code mods that make each prompt go further:

- **prompt-upgrade** turns a rough prompt into a clear one by asking a few multiple-choice questions, and then sends the result for you.
- **auto-model** picks the right model for each turn: Haiku for small things, Fable for the hardest work.

## The problem they solve

Most disappointing answers start with an underspecified prompt. "Make a login page" leaves the stack, the scope and what "done" means for the model to guess. It guesses, you correct it, and a few rounds go by. Writing a complete prompt yourself takes discipline, and it is hard to see what you left out.

**prompt-upgrade** asks the few questions that matter, the same way plan mode asks. They come as options you can pick in a second, with an "Other" box when none fit. It then writes the complete prompt and sends it. You answer three quick questions instead of typing three paragraphs, and you never copy or paste anything.

Different prompts also need different models. A rename does not need the strongest model, and a concurrency bug should not get the fastest one. Switching by hand with `/model` is easy to forget. **auto-model** reads each prompt and sends the turn to the model that fits, with high thinking effort on every tier. The status line says what it picked and why.

| Mod | What it does | Commands |
|---|---|---|
| [prompt-upgrade](prompt-upgrade) | Asks up to three multiple-choice questions in the chat, rewrites your prompt with the answers, and sends it | `/better <prompt>`, `/better on` / `off`, `/better history` |
| [auto-model](auto-model) | Picks the model for each turn from how hard the prompt looks | `/auto-model`, `on`, `off`, `set`, `reset`, `try` |

## Requirements: an early-access feature

> [!IMPORTANT]
> Both mods are built on Claude Code's **function hooks** (hooks modules). That API is in **early access**: it is still rolling out, and it may change between releases.

- **Tested with:** Claude Code **2.1.300**. Older versions may not load the mods, and newer ones may change the API.
- **Not every install has it yet.** If hooks modules are off for your Claude Code, the plugins install, but `/better` and `/auto-model` do not appear, and nothing happens. `claude --debug` then logs a line saying that hooks modules are turned off for installed plugins.
- **Surfaces:** the terminal and the desktop app. Questions use Claude Code's own AskUserQuestion dialog, so they need an interactive session. They do nothing under `claude -p`.

## Install

At the prompt of a terminal Claude Code session, run the line below, answer `y` to add the marketplace, and choose a scope:

```bash
/plugin install prompt-upgrade --marketplace Caesarcph/claude-mods
```

```bash
/plugin install auto-model --marketplace Caesarcph/claude-mods
```

From a shell, use `claude plugin install <mod> --marketplace Caesarcph/claude-mods` instead.

The desktop app has no `/plugin` command. Click **+** next to the prompt box, choose **Plugins**, then **Add marketplace** with `Caesarcph/claude-mods`, then **Add plugin**.

To update later, run `/plugin marketplace update chenp-mods` and `/plugin update <mod>`, then restart Claude Code. From a shell, run `claude plugin marketplace update chenp-mods` and `claude plugin update <mod>@chenp-mods`. If prompt-upgrade still opens a side pane with a Run button, you are on the old 0.1 version: update it.

## prompt-upgrade

1. Type `/better make a login page`. You can also run `/better on` and then type prompts as usual.
2. Up to three questions pop up one after another. Each has options and an "Other" box for your own answer. Press **Esc** to cancel: your prompt goes back into the prompt box and nothing is sent.
3. The upgraded prompt is sent as your message. A line above it says how much the prompt grew and what was added.

The questions read the conversation first: its first request, its latest messages and the tools that ran. They don't ask what was already settled, and the options are specific to your work. The rewrite fills in names the conversation already gave, such as files, models and servers. Questions and the rewrite are written in the language of your prompt.

| Option (`/config`) | Default | Meaning |
|---|---|---|
| `questionModel` | `haiku` | Model that writes the questions |
| `rewriteModel` | `sonnet` | Model that writes the upgraded prompt |
| `maxQuestions` | `3` | At most 1–4 questions. Fewer, or none, when the prompt is already clear |
| `review` | `send` | `review` adds one last dialog: send, edit first, or send your original |
| `memory` | `recent` | How much of the conversation the questions and the rewrite see. `recent`: the first request plus the latest messages and tool calls, up to about 12,000 characters. `full`: the whole conversation, by asking the main conversation itself (session model, from the prompt cache) |

**Automatic mode** (`/better on`) works on the prompt as you send it. Nothing is blocked: the questions appear right after you press Enter, and what goes to Claude is the upgraded prompt. Press Esc on a question to skip the upgrade and send your prompt as typed. Press Esc while it is rewriting to cancel; the prompt goes back into the box.

Automatic mode leaves these prompts as typed:
- slash commands and `!` shell lines
- short replies such as "yes" or "继续"
- prompts with attachments or `@` mentions
- prompts over 150 words
- anything typed while Claude is working

Start a prompt with `>` to send it exactly as typed.

## auto-model

| Tier | Model | Thinking effort | Typical prompt |
|---|---|---|---|
| easy | haiku | high | a lookup, a rename, a short explanation |
| medium | sonnet | high | a normal task in one or two files |
| hard | opus | high | multi-file work, debugging, a design decision |
| expert | fable | high | architecture, migrations, concurrency, security |

- **Change a tier:** run `/auto-model set <tier> <model> [effort]`, for example `/auto-model set easy sonnet low`. You can also change the `modelEasy`, `effortEasy`, … `modelExpert`, `effortExpert` options in `/config`.
- **See where a prompt lands:** `/auto-model try <prompt>` shows the tier without sending anything.
- **Who judges difficulty:** by default a quick `judgeModel` call (`haiku`) reads your prompt together with the conversation: the first request, the latest messages and the tool calls. So "更新我的论文" or "继续" is judged by the work it means, not by its length. If the call fails or takes over 5 s, local rules answer instead (keywords, size, code blocks, stack traces, in English and Chinese). Set `difficultyJudge` to `rules` to use the rules alone.
- **The work counts, not the wording.** A follow-up such as "继续", "fix it" or "修一下这个" never drops below the tier of the turn it continues. With the rules alone, a follow-up gets at least the tier of the last real request. A short request in the middle of real work is at least medium unless it says it is small. The status line says why, for example `auto-model: hard (Detailed paper revision; multi-part work) → claude-opus-5-5 · high`. `(rules: …)` marks a rules decision.
- **When a model fails:** the turn carries on with the session's model, and the status line shows the API's reason. Some failures won't clear up during the session: a model your account is not served, or one whose usage limit is spent. Such a model is skipped for the rest of the session.

## Extra model calls and cost

Both mods use your own Claude account and its usage limits. Nothing goes to a third party.

| Mod | Extra calls | Notes |
|---|---|---|
| prompt-upgrade | **2 per upgrade**: one to `questionModel` (medium effort, up to 1,500 output tokens) and one to `rewriteModel` (high effort, up to 3,000 output tokens) | Each call reads your prompt and up to about 12,000 characters of conversation (`memory: recent`). With `memory: full`, both calls run on the session's model over the whole conversation. They are mostly prompt-cache reads, but cost more in a long session. The upgraded prompt is longer than the rough one, so the turn that follows reads a few hundred more tokens. Prompts that automatic mode skips cost nothing. |
| auto-model | **1 per turn** by default: a `judgeModel` (haiku) call that reads up to about 6,000 characters of conversation and answers in under 80 tokens, adding about a second before the turn starts. **0** with `difficultyJudge: rules` | Switching models changes what a turn costs. Haiku and Sonnet cost less than Opus and Fable, and high effort spends more thinking tokens than low. The prompt cache is kept per model, so the first turn on a newly chosen model reads the conversation again without the cache. |

To spend less:
- Lower `maxQuestions`.
- Keep `/better` manual instead of automatic mode.
- Lower an effort, for example `/auto-model set easy haiku low`.
- Use `difficultyJudge: rules` to skip the judge call, or turn auto-model off with `/auto-model off`.

## Notes

- auto-model is on by default. prompt-upgrade's automatic mode is off until you run `/better on`.
- Model aliases (`haiku`, `sonnet`, `opus`, `fable`) are turned into full model IDs before they are sent.
- Settings made with `/auto-model set` are stored on each machine, not in this repository.
- Bugs and ideas: [open an issue](https://github.com/Caesarcph/claude-mods/issues).

## License

MIT. See [LICENSE](LICENSE).
