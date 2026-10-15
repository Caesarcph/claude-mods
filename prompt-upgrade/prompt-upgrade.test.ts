import { describe, expect, mock, test } from 'claude-code/testing'
import type { FoundElement } from 'claude-code/testing'

import {
  bigNumber,
  classify,
  countWords,
  parseQuestions,
  parseRewrite,
  withHistory,
} from './hooks/logic'

const USAGE = {
  input_tokens: 1,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

const ROUGH = 'write a blog post about dogs'

const QUESTIONS_JSON = JSON.stringify({
  questions: [
    { question: 'Who is it for?', options: ['New owners', 'Vets', 'Kids'] },
    { question: 'How long?', options: ['Short', 'Medium', 'Long'] },
  ],
})

const REWRITE_JSON = JSON.stringify({
  prompt:
    'Write a medium-length blog post about dogs for new owners. Goal: help them settle in. Done means: a clear checklist they can follow. Mention [breed] only if relevant.',
  added: ['Audience: new owners', 'Length: medium', 'Done means: a checklist'],
})

const PRESENTATION = { isFullscreen: true, columns: 120 }
const COMPOSER = { kind: 'composer' } as const

/** The world beneath the mod: what the engine would do, answered from memory. */
function world(
  on: any,
  options: { questions?: string; rewrite?: string; isNarrow?: boolean } = {},
) {
  const clock = mock.clock(on)
  const seen = {
    submitted: [] as string[],
    filled: [] as string[],
    closed: 0,
    opened: 0,
    toasts: [] as string[],
    copied: [] as string[],
    calls: [] as string[],
    rewritePrompts: [] as string[],
    failWith: null as null | 'api-error' | 'empty-reply',
    clock,
  }

  mock.store(on)

  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))

  on('command.register', () => ({ value: { command: 'better' } }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', (_: unknown, e: { text: string }) => {
    seen.filled.push(e.text)

    return { isFilled: true }
  })
  on('prompt.submit', (_: unknown, e: { text: string }) => {
    seen.submitted.push(e.text)

    return { text: e.text }
  })
  on('ui.open', () => {
    seen.opened += 1

    return { value: options.isNarrow ? { isPlaced: false, reason: 'too narrow' } : { isPlaced: true } }
  })
  on('ui.close', () => {
    seen.closed += 1

    return { value: undefined }
  })
  on('ui.toast', (_: unknown, e: { text: string }) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.copy', (_: unknown, e: { text: string }) => {
    seen.copied.push(e.text)

    return { value: { isCopied: true } }
  })
  on('model.complete', (_: unknown, e: { system?: string; prompt: string }) => {
    const isQuestions = (e.system ?? '').includes('multiple-choice')

    seen.calls.push(isQuestions ? 'questions' : 'rewrite')

    if (!isQuestions) {
      seen.rewritePrompts.push(e.prompt)
    }

    if (seen.failWith === 'api-error') {
      return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE } }
    }

    if (seen.failWith === 'empty-reply') {
      return { value: { isAnswered: false, reason: 'empty-reply', usage: USAGE } }
    }

    return {
      value: {
        isAnswered: true,
        text: isQuestions ? (options.questions ?? QUESTIONS_JSON) : (options.rewrite ?? REWRITE_JSON),
        usage: USAGE,
      },
    }
  })

  return seen
}

const run = (command: string, args: string) => ({
  command,
  args,
  origin: COMPOSER,
  presentation: PRESENTATION,
})

const typed = (text: string, extra: Record<string, unknown> = {}) => ({
  text,
  wait: false,
  origin: COMPOSER,
  ...extra,
})

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

const PANE = (columns: number) => ({
  title: 'Prompt Upgrade',
  isFocused: true,
  bodyColumns: columns,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
})

const mountPane = ($: any, surface: 'terminal' | 'desktop', columns = 110) =>
  $.ui.mount({
    plugin: 'prompt-upgrade',
    surface,
    component: 'Pane',
    requestId: 'prompt-upgrade',
    props: PANE(columns),
    viewport: { columns, rows: 40, isFullscreen: true },
  })

describe('which prompts are intercepted', () => {
  test('classify: only the person\'s own plain prompt is intercepted', () => {
    const intercepted = (text: string, extra: Record<string, unknown> = {}) =>
      classify({ text, origin: COMPOSER, ...extra }).kind === 'intercept'

    expect(intercepted(ROUGH)).toBe(true)
    expect(intercepted('/compact')).toBe(false)
    expect(intercepted('yes')).toBe(false)
    expect(intercepted('keep going')).toBe(false)
    expect(intercepted('ok thanks')).toBe(false)
    expect(intercepted('explain how the cache invalidation works here')).toBe(true)
    // Chinese is written without spaces: it must not be mistaken for a one-word reply.
    expect(intercepted('我怎么让我的其它电脑也安装')).toBe(true)
    expect(intercepted('帮我写一篇关于狗的博客')).toBe(true)
    expect(intercepted('好的')).toBe(false)
    expect(intercepted('继续')).toBe(false)
    expect(intercepted('好的，继续做吧')).toBe(false)
    expect(intercepted(ROUGH, { attachments: [{ type: 'image' }] })).toBe(false)
    expect(intercepted(ROUGH, { turnId: 'turn-1' })).toBe(false)
    expect(intercepted('look at @src/index.ts and fix the bug')).toBe(false)
    expect(classify({ text: ROUGH, origin: { kind: 'plugin' } }).kind).toBe('pass')
    expect(classify({ text: '> send this exactly as typed', origin: COMPOSER })).toEqual({
      kind: 'strip',
      text: 'send this exactly as typed',
    })
  })

  test('automatic mode: intercepts a rough prompt and lets the rest through', async ($, on) => {
    const seen = world(on)
    const clock = seen.clock

    await $.session.start(START)
    await $.command.run(run('better', 'on'))

    const intercepted = await $.prompt.submit(typed(ROUGH))
    expect(typeof (intercepted as { drop?: string }).drop).toBe('string')
    expect(seen.submitted).toEqual([])
    expect(seen.opened).toBeGreaterThan(0)
  })

  test('automatic mode: slash commands, replies, attachments, busy turns and ">" go straight through', async ($, on) => {
    const seen = world(on)
    const clock = seen.clock

    await $.session.start(START)
    await $.command.run(run('better', 'on'))

    await $.prompt.submit(typed('/compact'))
    await $.prompt.submit(typed('yes'))
    await $.prompt.submit(typed('keep going'))
    await $.prompt.submit(typed(ROUGH, { attachments: [{ type: 'image' }] }))
    await $.prompt.submit(typed(ROUGH, { turnId: 'turn-1' }))
    await $.prompt.submit(typed('> send this one as it is'))

    expect(seen.submitted).toEqual([
      '/compact',
      'yes',
      'keep going',
      ROUGH,
      ROUGH,
      'send this one as it is',
    ])
    expect(seen.opened).toBe(0)
  })

  test('the upgraded prompt the mod sends never loops back into the pane', async ($, on) => {
    const seen = world(on)
    const clock = seen.clock

    await $.session.start(START)
    await $.command.run(run('better', 'on'))
    await $.prompt.submit(typed(ROUGH))
    await seen.clock.settle()

    // A prompt the plugin itself submits arrives with a plugin origin.
    const sent = await $.prompt.submit({ text: 'write a longer blog post about dogs', wait: false, origin: { kind: 'plugin', name: 'prompt-upgrade' } })
    expect((sent as { drop?: string }).drop).toBe(undefined)
    expect(seen.submitted).toEqual(['write a longer blog post about dogs'])
  })
})

describe('the mod never intercepts its own prompt', () => {
  test('with automatic mode on, Run sends the upgrade once and opens no second pane', async ($, on) => {
    const seen = world(on)

    await $.session.start(START)
    await $.command.run(run('better', 'on'))

    const held = await $.prompt.submit(typed(ROUGH))
    expect(typeof (held as { drop?: string }).drop).toBe('string')
    await seen.clock.settle()

    const ui = await mountPane($, 'terminal')

    await ui.press({ key: 'skip-rest' })
    await seen.clock.settle()

    const opened = seen.opened
    const asked = seen.calls.length

    await ui.press({ key: 'run' })
    await seen.clock.settle()

    expect(seen.submitted.length).toBe(1)
    expect(seen.submitted[0]).toContain('blog post about dogs')
    expect(seen.opened).toBe(opened)
    expect(seen.calls.length).toBe(asked)
    await ui.unmount()
  })
})

describe('on and off', () => {
  test('/better on and /better off flip automatic mode and say so', async ($, on) => {
    const seen = world(on)
    const clock = seen.clock

    await $.session.start(START)

    // Off to begin with: a rough prompt goes straight through.
    await $.prompt.submit(typed(ROUGH))
    expect(seen.submitted).toEqual([ROUGH])

    const turnedOn = await $.command.run(run('better', 'on'))
    expect(turnedOn.text).toContain('is on')
    const held = await $.prompt.submit(typed('write a plan for the garden'))
    expect(typeof (held as { drop?: string }).drop).toBe('string')
    expect(seen.submitted).toEqual([ROUGH])

    const turnedOff = await $.command.run(run('better', 'off'))
    expect(turnedOff.text).toContain('is off')
    await $.prompt.submit(typed('write a plan for the garden'))
    expect(seen.submitted).toEqual([ROUGH, 'write a plan for the garden'])
  })
})

describe('reading what the model sends back', () => {
  test('questions: up to three, two to four options each, never Other or Skip', () => {
    const questions = parseQuestions(
      '```json\n' +
        JSON.stringify({
          questions: [
            { question: 'Who is it for?', options: ['New owners', 'Vets', 'Other', 'Skip', 'Kids', 'Teens', 'Adults'] },
            { question: 'Only one option?', options: ['Just this'] },
            { question: 'How long?', options: ['Short', 'Long'] },
            { question: 'Tone?', options: ['Warm', 'Dry'] },
            { question: 'One too many?', options: ['A', 'B'] },
          ],
        }) +
        '\n```',
    )

    expect(questions).not.toBe(null)
    expect(questions!.length).toBe(3)
    expect(questions![0]!.options).toEqual(['New owners', 'Vets', 'Kids', 'Teens'])
    expect(questions!.map(q => q.text)).toEqual(['Who is it for?', 'How long?', 'Tone?'])
  })

  test('questions: none needed is an empty list, nonsense is null', () => {
    expect(parseQuestions('{"questions":[]}')).toEqual([])
    expect(parseQuestions('I would ask about the audience.')).toBe(null)
  })

  test('rewrite: the prompt and what was added', () => {
    const out = parseRewrite(REWRITE_JSON)

    expect(out?.prompt).toContain('[breed]')
    expect(out?.added).toEqual(['Audience: new owners', 'Length: medium', 'Done means: a checklist'])
    expect(parseRewrite('{"prompt":"   "}')).toBe(null)
    expect(parseRewrite('no json here')).toBe(null)
  })

  test('numbers are drawn three rows tall', () => {
    const rows = bigNumber(48)

    expect(rows.length).toBe(3)
    expect(new Set(rows.map(row => row.length)).size).toBe(1)
    expect(countWords(ROUGH)).toBe(6)
    expect(countWords('写一篇博客 about dogs')).toBe(7)
    expect(withHistory([], { id: 'a', at: 1, original: 'x', upgraded: 'y', added: [], wordsBefore: 1, wordsAfter: 1 }).length).toBe(1)
  })
})

describe('the full flow', () => {
  test('/better to Run on both surfaces that take input', async ($, on) => {
    const seen = world(on)
    const clock = seen.clock

    await $.session.start(START)
    const started = await $.command.run(run('better', ROUGH))
    expect(started.text).toContain('Upgrading')
    await clock.settle()
    expect(seen.calls).toEqual(['questions'])

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await mountPane($, surface)

      expect(await ui.find({ type: 'Text', text: 'Who is it for?' })).toBeDefined()
      expect(await ui.find({ key: 'q1-New owners' })).toBeDefined()
      await ui.unmount()
    }

    const ui = await mountPane($, 'terminal')

    await ui.press({ key: 'q1-New owners' })
    expect(await ui.find({ type: 'Text', text: /1 of 2 answered/ })).toBeDefined()
    await ui.press({ key: 'q2-Medium' })
    await clock.settle()
    expect(seen.calls).toEqual(['questions', 'rewrite'])

    // The review: numbers, the buttons above the cards, then both cards.
    expect(await ui.find({ type: 'Text', text: /WHAT I ADDED/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Audience: new owners' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /THE UPGRADE/ })).toBeDefined()
    const buttons = (await ui.findAll({ type: 'Button' })).map((button: FoundElement) => button.key)
    expect(buttons.slice(0, 4)).toEqual(['run', 'edit', 'copy', 'cancel'])

    // Nothing runs until Run is pressed.
    expect(seen.submitted).toEqual([])
    await ui.press({ key: 'run' })
    await clock.settle()

    expect(seen.submitted.length).toBe(1)
    expect(seen.submitted[0]).toContain('blog post about dogs')
    expect(seen.closed).toBeGreaterThan(0)

    const shown = await $.command.run(run('better', 'history'))
    expect(shown.text).toContain('1 upgrade')
    await ui.unmount()
  })

  test('Skip the rest, upgrade now leaves skipped questions out of the rewrite', async ($, on) => {
    const seen = world(on)
    const clock = seen.clock

    await $.session.start(START)
    await $.command.run(run('better', ROUGH))
    await clock.settle()

    const ui = await mountPane($, 'terminal')

    await ui.press({ key: 'q1-Vets' })
    await ui.press({ key: 'skip-rest' })
    await clock.settle()

    expect(seen.calls).toContain('rewrite')
    expect(seen.rewritePrompts[0]).toContain('Vets')
    expect(seen.rewritePrompts[0]).not.toContain('How long?')
    await ui.unmount()
  })

  test('no question would help: straight to the rewrite', async ($, on) => {
    const seen = world(on, { questions: '{"questions":[]}' })
    const clock = seen.clock

    await $.session.start(START)
    await $.command.run(run('better', ROUGH))
    await clock.settle()

    expect(seen.calls).toEqual(['questions', 'rewrite'])
    const ui = await mountPane($, 'terminal')
    expect(await ui.find({ key: 'run' })).toBeDefined()
    await ui.unmount()
  })
})

describe('cancel, edit and errors', () => {
  test('Cancel closes the pane and puts the original prompt back', async ($, on) => {
    const seen = world(on)
    const clock = seen.clock

    await $.session.start(START)
    await $.command.run(run('better', ROUGH))
    await clock.settle()

    const ui = await mountPane($, 'terminal')

    await ui.press({ key: 'cancel' })
    await clock.settle()

    expect(seen.closed).toBeGreaterThan(0)
    expect(seen.filled).toEqual([ROUGH])
    expect(seen.submitted).toEqual([])
    await ui.unmount()
  })

  test('Edit changes the upgrade and Enter runs the edited text', async ($, on) => {
    const seen = world(on)
    const clock = seen.clock

    await $.session.start(START)
    await $.command.run(run('better', ROUGH))
    await clock.settle()

    const ui = await mountPane($, 'terminal')

    await ui.press({ key: 'skip-rest' })
    await clock.settle()
    await ui.press({ key: 'edit' })
    await ui.input({ key: 'edit', text: 'Write a short blog post about dogs.' })
    await clock.settle()

    expect(seen.submitted).toEqual(['Write a short blog post about dogs.'])
    await ui.unmount()
  })

  test('a failed model call shows a calm error card with three ways out', async ($, on) => {
    const seen = world(on)
    const clock = seen.clock

    seen.failWith = 'api-error'

    await $.session.start(START)
    await $.command.run(run('better', ROUGH))
    await clock.settle()

    const ui = await mountPane($, 'terminal')

    expect(await ui.find({ type: 'Text', text: /Your prompt is safe/ })).toBeDefined()
    const buttons = (await ui.findAll({ type: 'Button' })).map((button: FoundElement) => button.key)
    expect(buttons).toEqual(['retry', 'send-original', 'cancel'])

    seen.failWith = null
    await ui.press({ key: 'retry' })
    await clock.settle()
    expect(seen.calls).toContain('questions')
    expect(await ui.find({ key: 'q1-New owners' })).toBeDefined()

    await ui.unmount()
  })

  test('Send my original sends exactly what was typed', async ($, on) => {
    const seen = world(on)
    const clock = seen.clock

    seen.failWith = 'empty-reply'

    await $.session.start(START)
    await $.command.run(run('better', ROUGH))
    await clock.settle()

    const ui = await mountPane($, 'terminal')

    await ui.press({ key: 'send-original' })
    await clock.settle()
    expect(seen.submitted).toEqual([ROUGH])
    await ui.unmount()
  })

  test('a window too narrow puts the words back and says so', async ($, on) => {
    const seen = world(on, { isNarrow: true })
    const clock = seen.clock

    await $.session.start(START)
    await $.command.run(run('better', ROUGH))
    await clock.settle()

    expect(seen.filled).toEqual([ROUGH])
    expect(seen.toasts.length).toBe(1)
    expect(seen.calls).toEqual([])
  })
})

describe('history and reloads', () => {
  test('/better history lists upgrades and a click reopens the review', async ($, on) => {
    const { clock } = world(on)

    await $.session.start(START)
    await $.command.run(run('better', ROUGH))
    await clock.settle()

    const first = await mountPane($, 'terminal')

    await first.press({ key: 'skip-rest' })
    await clock.settle()
    await first.press({ key: 'cancel' })
    await clock.settle()
    await first.unmount()

    const shown = await $.command.run(run('better', 'history'))
    expect(shown.text).toContain('1 upgrade')

    const ui = await mountPane($, 'terminal')
    const rows = await ui.findAll({ type: 'Button' })
    const row = rows.find((button: FoundElement) => String(button.key).startsWith('history-'))

    expect(row).toBeDefined()
    await ui.press({ key: String(row!.key) })
    expect(await ui.find({ key: 'run' })).toBeDefined()
    await ui.unmount()
  })

  test('starting up again mid-step keeps one run going and the pane drawn', async ($, on) => {
    const seen = world(on)
    const clock = seen.clock

    await $.session.start(START)
    await $.command.run(run('better', ROUGH))
    // The module reloads before the timer ran: the run is kept in `$.state`.
    await $.session.start(START)
    await clock.settle()

    expect(seen.calls).toEqual(['questions'])
    const ui = await mountPane($, 'terminal')
    expect(await ui.find({ key: 'q1-New owners' })).toBeDefined()
    await ui.unmount()
  })
})

describe('sized to the pane', () => {
  test('rules fill the width at a narrow pane and a wide one', async ($, on) => {
    const { clock } = world(on)

    await $.session.start(START)
    await $.command.run(run('better', ROUGH))
    await clock.settle()

    for (const columns of [44, 120]) {
      const ui = await mountPane($, 'terminal', columns)
      const rules = (await ui.findAll({ type: 'Text' })).filter((text: FoundElement) => /─{3,}$/.test(text.text))

      expect(rules.length).toBeGreaterThan(0)

      for (const rule of rules) {
        expect(rule.text.length).toBeLessThanOrEqual(columns)
      }

      const title = rules.find((text: FoundElement) => text.text.startsWith('━'))
      expect(title?.text.length).toBe(columns)
      await ui.unmount()
    }

    const step = await mountPane($, 'terminal', 120)

    await step.press({ key: 'skip-rest' })
    await clock.settle()
    await step.unmount()

    for (const columns of [44, 120]) {
      const ui = await mountPane($, 'terminal', columns)
      const texts = (await ui.findAll({ type: 'Text' })).map((text: FoundElement) => text.text)

      for (const text of texts.filter((line: string) => /─{3,}$/.test(line))) {
        expect(text.length).toBeLessThanOrEqual(columns)
      }

      // Wide: three tiles with big numbers. Narrow: the same numbers on one line.
      const hasTiles = texts.some((line: string) => line === 'WORDS BEFORE')
      const hasLine = texts.some((line: string) => /words before/.test(line))

      expect(columns >= 60 ? hasTiles : hasLine).toBe(true)
      expect(await ui.find({ key: 'run' })).toBeDefined()
      await ui.unmount()
    }
  })
})
