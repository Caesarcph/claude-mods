# chenp-mods

[English](README.md) · **简体中文**

两个 Claude Code mod，让每一条提示词发挥更大作用：

- **prompt-upgrade**：先问你几个选择题，把粗糙的提示词改写清楚，然后替你发出去。
- **auto-model**：按难度给每一轮挑合适的模型，小事交给 Haiku，最难的活交给 Fable。

## 它们解决什么问题

很多不理想的回答，问题出在提示词说得不够清楚。"帮我写个登录页"没说技术栈、范围，也没说做到什么程度算完成，模型只能猜。猜错了你再纠正，这样来回好几轮。自己把提示词写完整又费劲，而且很难发现自己漏了什么。

**prompt-upgrade** 会像 plan 模式那样，只问最关键的几个问题。每题都给现成的选项，一秒就能选；没有合适的，也可以在"其他"里自己填。答完后，它写出完整的提示词并直接发出去。你只要回答三道选择题，不用写三段话，也不用复制粘贴。

另外，不同的任务适合不同的模型。改个变量名用不着最强的模型，查并发 bug 也不该交给最快的那个。用 `/model` 手动切换又很容易忘。**auto-model** 会读每条提示词，把这一轮交给合适的模型，并且每一档都用高思考力度。状态栏会显示选了哪个模型、为什么这样选。

| Mod | 作用 | 命令 |
|---|---|---|
| [prompt-upgrade](prompt-upgrade) | 在对话里问最多 3 道选择题，按回答改写提示词并直接发送 | `/better <提示词>`、`/better on` / `off`、`/better history` |
| [auto-model](auto-model) | 按提示词的难度，给每一轮选择模型 | `/auto-model`、`on`、`off`、`set`、`reset`、`try` |

## 适用版本：早期访问功能

> [!IMPORTANT]
> 两个 mod 都基于 Claude Code 的**函数 hooks**（hooks modules）。这个接口目前处于**早期访问**阶段，还在逐步放量，不同版本之间也可能有变化。

- **测试版本**：Claude Code **2.1.300**。更早的版本可能加载不了，更新的版本也可能改了接口。
- **不是每个人都已开启**：如果你的 Claude Code 还没开启 hooks modules，插件能装上，但不会出现 `/better` 和 `/auto-model` 命令，也不会有任何效果。这时用 `claude --debug` 启动，日志里会有一行说明已安装插件的 hooks modules 处于关闭状态。
- **可用环境**：终端和桌面 App。问题用的是 Claude Code 自带的 AskUserQuestion 对话框，所以需要交互式会话，在 `claude -p` 下不起作用。

## 安装

在终端版 Claude Code 的输入框里运行下面一行，提示添加 marketplace 时回答 `y`，再选安装范围：

```bash
/plugin install prompt-upgrade --marketplace Caesarcph/claude-mods
```

```bash
/plugin install auto-model --marketplace Caesarcph/claude-mods
```

在系统终端里，改用 `claude plugin install <mod> --marketplace Caesarcph/claude-mods`。

桌面 App 里没有 `/plugin` 命令：点输入框旁边的 **+**，选 **Plugins**，再点 **Add marketplace**，填 `Caesarcph/claude-mods`，最后点 **Add plugin**。

以后更新时，运行 `/plugin marketplace update chenp-mods` 和 `/plugin update <mod>`，然后重启 Claude Code。

## prompt-upgrade

1. 输入 `/better 帮我写个登录页`。也可以先运行 `/better on`，之后像平时一样直接输入提示词。
2. 最多弹出 3 道题，一题接一题。每题都有选项，也有"其他"可以自己填。按 **Esc** 会取消：原文放回输入框，什么都不会发送。
3. 优化后的提示词会以你的名义发出去。消息上方有一行说明，写着字数增加了多少、补充了哪些内容。

出题时会参考最近几条对话，所以不会问刚刚聊过的内容。问题和改写结果都用你提示词的语言。

| 选项（`/config`） | 默认值 | 含义 |
|---|---|---|
| `questionModel` | `haiku` | 出题用的模型 |
| `rewriteModel` | `sonnet` | 改写用的模型 |
| `maxQuestions` | `3` | 最多问 1–4 题。提示词已经很清楚时会少问，甚至不问 |
| `review` | `send` | 设为 `review` 时，发送前再弹一次确认：发送、先改一下、或发原文 |

**自动模式**（`/better on`）不会处理以下这些，它们会原样发送：
- 斜杠命令、`!` 开头的命令行
- "好的"、"继续"、"yes" 这类短回复
- 带附件或 `@` 引用的提示词
- 超过 150 字的提示词
- Claude 正在工作时输入的内容

在提示词前加 `>`，就会原样发送。

## auto-model

| 档位 | 模型 | 思考力度 | 典型提示词 |
|---|---|---|---|
| easy | haiku | high | 查一下、改个名、简短解释 |
| medium | sonnet | high | 一两个文件里的常规任务 |
| hard | opus | high | 跨文件修改、排查 bug、做设计决定 |
| expert | fable | high | 架构、迁移、并发、安全 |

- **修改某一档**：运行 `/auto-model set <档位> <模型> [思考力度]`，例如 `/auto-model set easy sonnet low`。也可以在 `/config` 里改 `modelEasy`、`effortEasy` … `modelExpert`、`effortExpert`。
- **预览会落在哪一档**：`/auto-model try <提示词>` 只显示结果，不会发送。
- **谁来判断难度**：默认用本地规则，依据关键词、长度、代码块、报错堆栈等，中英文都支持。把 `judge` 设为 `model`，就改由模型快速评估每条提示词，用的是 `judgeModel`，默认 haiku。
- **短回复**："继续"、"好的"这类回复会沿用上一轮的档位。
- **模型调用失败时**：这一轮自动改用会话本身的模型，状态栏会显示 API 返回的原因。如果是会话期间不会好转的问题，比如账号不提供这个模型、或这个模型的用量额度用完了，本次会话后面就不再尝试它。

## 额外的模型调用和花费

两个 mod 都通过你自己的 Claude 账号调用模型，算在你自己的用量额度里，不会发给任何第三方。

| Mod | 额外调用 | 说明 |
|---|---|---|
| prompt-upgrade | **每次优化 2 次**：出题模型 1 次（低思考力度，最多输出 1,500 tokens），改写模型 1 次（高思考力度，最多输出 3,000 tokens） | 每次调用会读你的提示词和最近约 3,000 字的对话。优化后的提示词比原文长，所以接下来那一轮会多读几百个 token。自动模式跳过的提示词不产生任何花费。 |
| auto-model | 默认用规则判断，**0 次**。设为 `judge: model` 时**每轮 1 次**：调用 `judgeModel`，最多输出 80 tokens，少于 4 个词的提示词不调用 | 切换模型本身会改变每轮的花费：Haiku 和 Sonnet 比 Opus 和 Fable 便宜，高思考力度也比低力度消耗更多思考 token。提示缓存是按模型分开的，所以每次切换到一个新模型的第一轮，要在没有缓存的情况下重新读一遍对话。 |

想省钱可以这样：
- 把 `maxQuestions` 调低。
- 只手动用 `/better`，不开自动模式。
- 调低某一档的思考力度，例如 `/auto-model set easy haiku low`。
- 长会话里用 `/auto-model off` 关掉 auto-model。

## 其他说明

- auto-model 默认开启。prompt-upgrade 的自动模式默认关闭，运行 `/better on` 才会打开。
- 模型简称（`haiku`、`sonnet`、`opus`、`fable`）会先换成完整的模型 ID 再发送。
- `/auto-model set` 的设置保存在每台电脑本地，不在这个仓库里。
- 发现问题或有建议：[提交 issue](https://github.com/Caesarcph/claude-mods/issues)。

## 许可证

MIT，详见 [LICENSE](LICENSE)。
