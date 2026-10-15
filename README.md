# chenp-mods

Two Claude Code mods, packed as one marketplace.

| Mod | What it does |
|---|---|
| [prompt-upgrade](prompt-upgrade) | Turns a rough prompt into a clear one in a pane, after up to three quick questions. Nothing is sent until you press Run. Commands: `/better`, `/better on`/`off`, `/better history`. |
| [auto-model](auto-model) | Picks the model and thinking effort for each turn from how hard the prompt looks. Commands: `/auto-model`, `on`, `off`, `set`, `reset`, `try`. |

## Install

Run this at the prompt of a terminal Claude Code session, answer `y` to add the marketplace, then choose a scope:

```bash
/plugin install prompt-upgrade --marketplace Caesarcph/claude-mods
```

```bash
/plugin install auto-model --marketplace Caesarcph/claude-mods
```

## Notes

- `auto-model` is on by default, and `prompt-upgrade`'s automatic mode is off until you run `/better on`.
- Model aliases (`haiku`, `sonnet`, `opus`) are turned into full model IDs before they are sent.
- Settings made with `/auto-model set` are stored on each machine, not in this repository.
