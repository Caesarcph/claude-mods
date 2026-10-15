import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import {
  REWRITE_SYSTEM,
  chip,
  classify,
  contextFrom,
  countWords,
  fit,
  formatHistory,
  isChinese,
  makeId,
  parseQuestions,
  parseRewrite,
  questionPrompt,
  questionSystem,
  readHistory,
  rewritePrompt,
  withHistory,
} from './logic'
import type { Given, HistoryItem, Question, Verdict } from './logic'

type Dollar = EngineInterface

type Settings = { questionModel: string; rewriteModel: string; maxQuestions: number; isReview: boolean; isFullMemory: boolean }

const say = (zh: boolean, chinese: string, english: string) => (zh ? chinese : english)

const textOption = (value: unknown, fallback: string) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback

const settingsOf = (options: PluginOptions): Settings => {
  const max = Number.parseInt(String(options['maxQuestions'] ?? '3'), 10)

  return {
    questionModel: textOption(options['questionModel'], 'haiku'),
    rewriteModel: textOption(options['rewriteModel'], 'sonnet'),
    maxQuestions: Number.isFinite(max) ? Math.max(1, Math.min(4, max)) : 3,
    isReview: options['review'] === 'review',
    isFullMemory: options['memory'] === 'full',
  }
}

type Failed = { reason: string; status?: number | null }

const whyFailed = (zh: boolean, res: Failed): string => {
  if (res.reason === 'api-error') {
    const code = res.status === null || res.status === undefined ? '' : ` ${res.status}`

    return say(zh, `模型服务返回了错误${code}`, `the model service answered with an error${code}`)
  }

  if (res.reason === 'empty-reply') {
    return say(zh, '模型返回了空内容', 'the model sent back an empty reply')
  }

  return say(zh, '模型响应超时', 'the model took too long')
}

// One upgrade at a time. A module variable: a reload mid-upgrade starts clean.
let isBusy = false
let seq = 0

/** Which language to answer a bare command in: the person's setting, else their last upgrade. */
const prefersChinese = async ($: Dollar): Promise<boolean> => {
  try {
    const language = (await $.settings.read())['language']

    if (typeof language === 'string' && language.trim() !== '') {
      return /chin|中文|zh|简体|繁體/i.test(language)
    }
  } catch {
    // Fall through to the history.
  }

  const last = readHistory(await $.store.get('history'))[0]

  return last !== undefined && isChinese(last.original)
}

/** Puts words back in the prompt box, keeping what is already there. */
const putBack = async ($: Dollar, text: string) => {
  try {
    const box = await $.prompt.read()
    const have = box.text.trim()

    if (have.includes(text.trim())) {
      return
    }

    await $.prompt.fill({ text: have === '' ? text : `${box.text}\n\n${text}`, mode: 'replace' })
  } catch {
    // Nothing more to do: the log line says what happened.
  }
}

// Said ahead of a fork's request: the fork is the main conversation itself, so it must not take the request as the task.
const FORK_HEAD = [
  'This message is from the Prompt Upgrade plugin, not from the user. Do not use tools and do not start on any task.',
  'The user is about to send the rough prompt below as their next message. Using everything in this conversation, follow the instructions below.',
].join(' ')

type Call = { model: string; system: string; prompt: string; maxTokens: number; effort: 'low' | 'medium' | 'high'; timeoutMs: number }

/**
 * One model call of the upgrade. With memory set to full it is a fork of the
 * main conversation (the session's model, the whole transcript, from the
 * prompt cache); when there is nothing to fork yet or the fork fails, and
 * otherwise, it is a plain completion over the recent conversation.
 */
const callModel = async ($: Dollar, settings: Settings, call: Call, forkPrompt: string) => {
  if (settings.isFullMemory) {
    try {
      const forked = await $.model.fork({ prompt: `${FORK_HEAD}\n\n${call.system}\n\n${forkPrompt}` })

      if (forked.isAnswered) {
        return forked
      }
    } catch {
      // The plain completion below answers instead.
    }
  }

  return $.model.complete(call)
}

const readContext = async ($: Dollar): Promise<string> => {
  try {
    return contextFrom(await $.session.messages())
  } catch {
    return ''
  }
}

const remember = async ($: Dollar, original: string, upgraded: string, added: string[]) => {
  try {
    const now = await $.clock.now()
    seq += 1
    const item: HistoryItem = {
      id: makeId(now, seq),
      at: now,
      original,
      upgraded,
      added,
      wordsBefore: countWords(original),
      wordsAfter: countWords(upgraded),
    }

    await $.store.set('history', withHistory(readHistory(await $.store.get('history')), item))
  } catch {
    // The upgrade still stands; only the saved history missed it.
  }
}

/**
 * Asks each question in the engine's own AskUserQuestion dialog, the one plan
 * mode uses: the options, plus Other to type an answer. `null` when dismissed.
 */
const askAll = async ($: Dollar, questions: Question[]): Promise<Given[] | null> => {
  const given: Given[] = []

  for (const [index, question] of questions.entries()) {
    let answer: string

    try {
      answer = await $.ui.ask(question.question, {
        options: question.options,
        header: chip(question, index, questions.length),
        ...(question.multiSelect ? { multiSelect: true as const } : {}),
      })
    } catch {
      return null
    }

    if (answer.trim() !== '') {
      given.push({ question: question.question, answer: answer.trim() })
    }
  }

  return given
}

/** The last look before sending, when the options ask for one. The upgrade is shown just above it. */
const review = async ($: Dollar, zh: boolean, upgraded: string): Promise<'send' | 'edit' | 'original'> => {
  const send = say(zh, '发送', 'Send it')
  const edit = say(zh, '先改一下', 'Edit first')
  const mine = say(zh, '发原文', 'Send my original')

  $.ui.log(say(zh, `Prompt Upgrade 优化后的提示词：\n${upgraded}`, `Prompt Upgrade, the upgraded prompt:\n${upgraded}`))

  try {
    const answer = await $.ui.ask(say(zh, '发送上面这条优化后的提示词吗？', 'Send the upgraded prompt shown above?'), {
      options: [send, edit, mine],
      header: say(zh, '确认', 'Review'),
    })

    return answer === send ? 'send' : answer === mine ? 'original' : 'edit'
  } catch {
    return 'edit'
  }
}

type Outcome =
  | { kind: 'send'; text: string }
  | { kind: 'edit'; text: string }
  | { kind: 'cancel' }
  | { kind: 'failed'; why: string }

/** Questions in the chat, then the rewrite. Sends nothing: the caller does, its own way. */
const prepare = async ($: Dollar, original: string, settings: Settings): Promise<Outcome> => {
  const zh = isChinese(original)

  try {
    $.ui.status(say(zh, 'Prompt Upgrade：正在看你的提示词…', 'Prompt Upgrade: reading your prompt…'))

    const context = await readContext($)
    const asked = await callModel(
      $,
      settings,
      {
        model: settings.questionModel,
        system: questionSystem(settings.maxQuestions),
        prompt: questionPrompt(original, context),
        maxTokens: 1500,
        effort: 'medium',
        timeoutMs: 30000,
      },
      questionPrompt(original, ''),
    )
    // Questions help but are not needed: without them the rewrite still runs.
    const questions = asked.isAnswered ? (parseQuestions(asked.text, settings.maxQuestions) ?? []) : []
    let answers: Given[] = []

    if (questions.length > 0) {
      $.ui.status(say(zh, 'Prompt Upgrade：等你回答', 'Prompt Upgrade: waiting for your answers'))

      const given = await askAll($, questions)

      if (given === null) {
        return { kind: 'cancel' }
      }

      answers = given
    }

    $.ui.status(say(zh, 'Prompt Upgrade：正在改写…', 'Prompt Upgrade: writing the upgrade…'))

    const written = await callModel(
      $,
      settings,
      {
        model: settings.rewriteModel,
        system: REWRITE_SYSTEM,
        prompt: rewritePrompt(original, answers, context),
        maxTokens: 3000,
        effort: 'high',
        timeoutMs: 90000,
      },
      rewritePrompt(original, answers, ''),
    )
    const out = written.isAnswered ? parseRewrite(written.text) : null

    if (out === null) {
      return { kind: 'failed', why: written.isAnswered ? say(zh, '返回格式无法读取', 'the reply could not be read') : whyFailed(zh, written) }
    }

    await remember($, original, out.prompt, out.added)

    if (settings.isReview) {
      $.ui.status(undefined)

      const choice = await review($, zh, out.prompt)

      if (choice === 'edit') {
        return { kind: 'edit', text: out.prompt }
      }

      if (choice === 'original') {
        return { kind: 'send', text: original }
      }
    }

    const shown = out.added.slice(0, 3)
    const more = out.added.length - shown.length
    const added =
      shown.length === 0
        ? ''
        : say(
            zh,
            ` · 补充了 ${shown.join('、')}${more > 0 ? ` 等 ${out.added.length} 项` : ''}`,
            ` · added ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`,
          )

    $.ui.log(say(zh, `Prompt Upgrade：${countWords(original)} → ${countWords(out.prompt)} 字${added}`, `Prompt Upgrade: ${countWords(original)} → ${countWords(out.prompt)} words${added}`))

    return { kind: 'send', text: out.prompt }
  } catch {
    return { kind: 'failed', why: say(zh, '出了点问题', 'something went wrong') }
  } finally {
    $.ui.status(undefined)
  }
}

/** `/better <prompt>`: runs from a timer, since it outlives the command, and submits the result itself. */
const startCommand = ($: Dollar, original: string, settings: Settings) => {
  const zh = isChinese(original)

  isBusy = true
  $.clock.after(0, () => {
    void (async () => {
      try {
        const outcome = await prepare($, original, settings)

        isBusy = false

        if (outcome.kind === 'send') {
          try {
            await $.prompt.submit({ text: outcome.text, asUser: true })
          } catch {
            await putBack($, outcome.text)
            $.ui.log(say(zh, 'Prompt Upgrade：没能发送，提示词放在了输入框里。', 'Prompt Upgrade: could not send it; the prompt is in the box.'))
          }
        } else if (outcome.kind === 'edit') {
          await putBack($, outcome.text)
          $.ui.log(say(zh, 'Prompt Upgrade：优化版在输入框里，改完按回车发送。', 'Prompt Upgrade: the upgrade is in the prompt box; edit it and press Enter.'))
        } else {
          await putBack($, original)
          $.ui.log(
            outcome.kind === 'cancel'
              ? say(zh, 'Prompt Upgrade：已取消，原文放回了输入框。', 'Prompt Upgrade: cancelled. Your prompt is back in the box.')
              : say(zh, `Prompt Upgrade：改写失败（${outcome.why}），原文放回了输入框。`, `Prompt Upgrade: the rewrite failed (${outcome.why}). Your prompt is back in the box.`),
          )
        }
      } finally {
        isBusy = false
      }
    })().catch(() => undefined)
  })
}

const help = (zh: boolean, isAuto: boolean) =>
  zh
    ? [
        `Prompt Upgrade · 自动模式：${isAuto ? '开' : '关'}`,
        '/better <提示词>   先在对话里问你几个选择题，再把优化后的提示词直接发出去',
        '/better on | off   自动模式：你输入的每条提示词都先这样优化（以 > 开头则原样发送）',
        '/better history    最近的优化记录',
      ].join('\n')
    : [
        `Prompt Upgrade · automatic mode: ${isAuto ? 'on' : 'off'}`,
        '/better <prompt>   asks a few multiple-choice questions in the chat, then sends the upgraded prompt',
        '/better on | off   automatic mode: every prompt you type is upgraded first (start with > to send as typed)',
        '/better history    recent upgrades',
      ].join('\n')

export const register: Register = (on, options) => {
  const settings = settingsOf(options)

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'better',
        description: 'Upgrade a rough prompt with a few quick questions, then send it: /better <prompt>, on, off, history',
        argumentHint: '[prompt | on | off | history]',
      })
    } catch {
      // The other hooks still work without the command.
    }

    return next(e)
  })

  on('command.run', { command: 'better' }, async ($, e) => {
    try {
      const args = e.args.trim()
      const word = args.toLowerCase()

      if (word === 'on' || word === 'off') {
        const zh = await prefersChinese($)
        const isAuto = word === 'on'

        await $.store.set('auto', isAuto)

        return {
          text: isAuto
            ? say(zh, '自动模式已开启：你输入的提示词会先问几个问题、优化后再发送。以 > 开头可原样发送。', 'Automatic mode is on: prompts you type get a few questions and are upgraded before they are sent. Start one with > to send it as typed.')
            : say(zh, '自动模式已关闭：提示词按原样发送。', 'Automatic mode is off: prompts are sent as you type them.'),
        }
      }

      if (word === 'history') {
        const zh = await prefersChinese($)
        const list = readHistory(await $.store.get('history'))

        return {
          text: list.length === 0 ? say(zh, '还没有优化记录。试试 /better 加上你的提示词。', 'No upgrades yet. Try /better followed by a rough prompt.') : formatHistory(list, zh),
        }
      }

      if (args === '') {
        return { text: help(await prefersChinese($), (await $.store.get('auto')) === true) }
      }

      const zh = isChinese(args)

      if (isBusy) {
        return { text: say(zh, '上一个优化还没完成，这条没有处理。', 'Another upgrade is still running; this one was not started.') }
      }

      startCommand($, args, settings)

      return { text: say(zh, `正在优化：${fit(args, 60)}`, `Upgrading: ${fit(args, 60)}`) }
    } catch (error) {
      const why = error instanceof Error ? error.message : 'unknown error'

      return { text: `Prompt Upgrade could not start (${why}). Nothing was sent.` }
    }
  }).catch(() => ({ text: 'Prompt Upgrade hit a problem and did nothing. Nothing was sent.' }))

  // Automatic mode: a plain prompt typed at an idle session gets the questions
  // right where it was sent, and goes on as the upgrade: nothing is blocked.
  on('prompt.submit', async ($, e, next) => {
    let verdict: Verdict = { kind: 'pass' }

    try {
      if (!isBusy && (await $.store.get('auto')) === true) {
        verdict = classify(e)
      }
    } catch {
      verdict = { kind: 'pass' }
    }

    if (verdict.kind === 'strip') {
      return next({ ...e, text: verdict.text })
    }

    if (verdict.kind !== 'intercept') {
      return next(e)
    }

    const zh = isChinese(e.text)
    let outcome: Outcome

    isBusy = true

    try {
      outcome = await prepare($, e.text, settings)
    } finally {
      isBusy = false
    }

    if (outcome.kind === 'send') {
      return next({ ...e, text: outcome.text })
    }

    if (outcome.kind === 'edit') {
      $.clock.after(0, () => {
        void putBack($, outcome.text)
      })

      return { drop: say(zh, 'Prompt Upgrade：优化版在输入框里，改完按回车发送。', 'Prompt Upgrade: the upgrade is in the prompt box; edit it and press Enter.') }
    }

    // Esc while it was rewriting: the engine has already put the prompt back.
    if (next.signal.aborted) {
      return next(e)
    }

    // You pressed Enter to send it: skipping the questions, or a failed rewrite, sends it as typed.
    $.ui.log(
      outcome.kind === 'cancel'
        ? say(zh, 'Prompt Upgrade：跳过了优化，按原样发送。', 'Prompt Upgrade: skipped; sent as typed.')
        : say(zh, `Prompt Upgrade：改写失败（${outcome.why}），按原样发送。`, `Prompt Upgrade: the rewrite failed (${outcome.why}); sent as typed.`),
    )

    return next(e)
  }).catch(($, e, next) => next(e))
}
