import { describe, expect, mock, test } from 'claude-code/testing'

import {
  chip,
  classify,
  contextFrom,
  countWords,
  parseQuestions,
  parseRewrite,
  readHistory,
  withHistory,
} from './hooks/logic'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const COMPOSER = { kind: 'composer' } as const
const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

const ROUGH = 'write a blog post about dogs'
const ROUGH_ZH = '帮我写一篇关于狗的博客'

const QUESTIONS_JSON = JSON.stringify({
  questions: [
    {
      header: 'Audience',
      question: 'Who is it for?',
      options: [
        { label: 'New owners', description: 'People who just got a dog' },
        { label: 'Vets', description: 'Professionals' },
      ],
      multiSelect: false,
    },
    { header: 'Length', question: 'How long?', options: ['Short', 'Medium', 'Long', 'Other'], multiSelect: false },
  ],
})

const UPGRADED = 'Write a medium-length blog post about dogs for new owners. Done means: a checklist they can follow.'
const REWRITE_JSON = JSON.stringify({ prompt: UPGRADED, added: ['Audience: new owners', 'Length: medium'] })

type WorldOptions = {
  questions?: string
  rewrite?: string
  /** What the dialog answers: answers by question, or 'dismiss'. */
  answers?: Record<string, string> | 'dismiss'
  /** What the review dialog answers. */
  reviewAnswer?: string
  messages?: { role: 'user' | 'assistant'; text: string }[]
  failRewrite?: boolean
}

/** The world beneath the mod: the engine's answers, from memory. */
function world(on: any, options: WorldOptions = {}) {
  const clock = mock.clock(on)
  const seen = {
    submitted: [] as { text: string; asUser?: boolean }[],
    filled: [] as string[],
    logs: [] as string[],
    asked: [] as any[],
    systems: [] as string[],
    questionPrompts: [] as string[],
    rewritePrompts: [] as string[],
    clock,
  }

  mock.store(on)

  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'better' } }))
  on('settings.read', () => ({ value: {} }))
  on('session.messages', () => ({ value: options.messages ?? [] }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', (_: unknown, e: { text: string }) => {
    seen.filled.push(e.text)

    return { isFilled: true }
  })
  on('prompt.submit', (_: unknown, e: { text: string; origin?: { asUser?: boolean } }) => {
    seen.submitted.push({ text: e.text, asUser: e.origin?.asUser })

    return { text: e.text }
  })
  on('ui.log', (_: unknown, e: { text: string }) => {
    seen.logs.push(e.text)

    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_: unknown, e: { questions: { question: string; header: string; options: { label: string }[] }[] }) => {
    const asked = e.questions[0]!

    seen.asked.push(asked)

    if (asked.header === 'Review') {
      return { result: { questions: e.questions, answers: { [asked.question]: options.reviewAnswer ?? 'Send it' } } }
    }

    if (options.answers === 'dismiss') {
      return { deny: 'The user dismissed the dialog' }
    }

    const answers = options.answers ?? { 'Who is it for?': 'New owners', 'How long?': 'Medium' }

    return { result: { questions: e.questions, answers: { [asked.question]: answers[asked.question] ?? '' } } }
  })
  on('model.complete', (_: unknown, e: { system?: string; prompt: string }) => {
    const system = e.system ?? ''
    const isQuestions = system.includes('multiple-choice')

    seen.systems.push(isQuestions ? 'questions' : 'rewrite')

    if (isQuestions) {
      seen.questionPrompts.push(e.prompt)
    }

    if (!isQuestions) {
      seen.rewritePrompts.push(e.prompt)

      if (options.failRewrite) {
        return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE } }
      }
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

const better = ($: any, args: string) =>
  $.command.run({ command: 'better', args, origin: COMPOSER, presentation: { isFullscreen: true, columns: 120 } })

const typed = (text: string, extra: Record<string, unknown> = {}) => ({ text, wait: false, origin: COMPOSER, ...extra })

describe('reading the model', () => {
  test('questions: headers, options with descriptions, no Other or Skip, at most the limit', () => {
    const questions = parseQuestions(QUESTIONS_JSON)

    expect(questions).toEqual([
      { header: 'Audience', question: 'Who is it for?', options: ['New owners', 'Vets'], multiSelect: false },
      { header: 'Length', question: 'How long?', options: ['Short', 'Medium', 'Long'], multiSelect: false },
    ])
    expect(parseQuestions(QUESTIONS_JSON, 1)?.length).toBe(1)
    expect(parseQuestions('```json\n{"questions":[]}\n```')).toEqual([])
    expect(parseQuestions('no idea')).toBe(null)
    // "Otherwise" is a real option; "其他" is not.
    expect(parseQuestions('{"questions":[{"question":"Q?","options":["Otherwise","其他","Fine"]}]}')?.[0]?.options).toEqual([
      'Otherwise',
      'Fine',
    ])
  })

  test('the rewrite is read, and each dialog gets a short chip', () => {
    expect(parseRewrite(REWRITE_JSON)).toEqual({ prompt: UPGRADED, added: ['Audience: new owners', 'Length: medium'] })
    expect(parseRewrite('{"prompt":""}')).toBe(null)

    const [first] = parseQuestions(QUESTIONS_JSON) ?? []

    expect(chip(first!, 0, 2)).toBe('1/2 Audience')
    expect(chip(first!, 0, 1)).toBe('Audience')
    expect(chip({ ...first!, header: 'Very long header' }, 2, 3).length).toBeLessThan(13)
  })

  test('words count Chinese characters one by one, and history keeps twenty', () => {
    expect(countWords('hello world')).toBe(2)
    expect(countWords('写一篇博客')).toBe(5)

    let list = readHistory('nonsense')

    for (let i = 0; i < 25; i += 1) {
      list = withHistory(list, { id: String(i), at: i, original: 'a', upgraded: 'b', added: [], wordsBefore: 1, wordsAfter: 1 })
    }

    expect(list.length).toBe(20)
    expect(list[0]?.id).toBe('24')
  })

  test('the conversation context is the last few messages, trimmed', () => {
    const context = contextFrom([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: '' },
      { role: 'assistant', text: 'x'.repeat(2000) },
    ])

    expect(context.startsWith('User: first\nAssistant: ')).toBe(true)
    expect(context.length).toBeLessThan(700)
  })
})

describe('which prompts automatic mode takes', () => {
  test('only the person\'s own plain prompt is taken', () => {
    const taken = (text: string, extra: Record<string, unknown> = {}) => classify({ text, origin: COMPOSER, ...extra }).kind === 'intercept'

    expect(taken(ROUGH)).toBe(true)
    expect(taken(ROUGH_ZH)).toBe(true)
    expect(taken('/compact')).toBe(false)
    expect(taken('!ls')).toBe(false)
    expect(taken('yes')).toBe(false)
    expect(taken('keep going')).toBe(false)
    expect(taken('好的')).toBe(false)
    expect(taken('好的，继续做吧')).toBe(false)
    expect(taken(ROUGH, { attachments: [{ type: 'image' }] })).toBe(false)
    expect(taken(ROUGH, { turnId: 'turn-1' })).toBe(false)
    expect(taken('look at @src/index.ts and fix the bug')).toBe(false)
    expect(taken('word '.repeat(200))).toBe(false)
    expect(classify({ text: ROUGH, origin: { kind: 'plugin' } }).kind).toBe('pass')
    expect(classify({ text: '> send this exactly', origin: COMPOSER })).toEqual({ kind: 'strip', text: 'send this exactly' })
  })
})

describe('upgrading in the chat', () => {
  test('/better asks in the dialog, rewrites with the answers and sends it as the person', async ($, on) => {
    const seen = world(on)

    await $.session.start(START)

    const said = await better($, ROUGH)
    expect(said.text).toContain('Upgrading')

    await seen.clock.settle()

    // One dialog per question, as plan mode asks, each with its options.
    expect(seen.asked.map((q: { header: string }) => q.header)).toEqual(['1/2 Audience', '2/2 Length'])
    expect(seen.asked[0].options.map((o: { label: string }) => o.label)).toEqual(['New owners', 'Vets'])
    expect(seen.rewritePrompts[0]).toContain('A: New owners')
    expect(seen.rewritePrompts[0]).toContain('A: Medium')
    expect(seen.submitted).toEqual([{ text: UPGRADED, asUser: true }])
    expect(seen.logs.join('\n')).toContain('6 → 17 words')

    const history = await better($, 'history')
    expect(history.text).toContain(ROUGH)
  })

  test('the conversation so far is shown to the question model', async ($, on) => {
    const seen = world(on, { messages: [{ role: 'user', text: 'we use Next.js 15' }] })

    await $.session.start(START)
    await better($, ROUGH)
    await seen.clock.settle()

    expect(seen.questionPrompts[0]).toContain('we use Next.js 15')
  })

  test('a clear prompt gets no questions and is sent straight after the rewrite', async ($, on) => {
    const seen = world(on, { questions: '{"questions":[]}' })

    await $.session.start(START)
    await better($, ROUGH)
    await seen.clock.settle()

    expect(seen.asked).toEqual([])
    expect(seen.submitted.map(one => one.text)).toEqual([UPGRADED])
  })

  test('dismissing the dialog sends nothing and puts the prompt back', async ($, on) => {
    const seen = world(on, { answers: 'dismiss' })

    await $.session.start(START)
    await better($, ROUGH_ZH)
    await seen.clock.settle()

    expect(seen.submitted).toEqual([])
    expect(seen.filled).toEqual([ROUGH_ZH])
    expect(seen.logs.join('\n')).toContain('已取消')
  })

  test('a failed rewrite sends nothing and puts the prompt back', async ($, on) => {
    const seen = world(on, { failRewrite: true })

    await $.session.start(START)
    await better($, ROUGH)
    await seen.clock.settle()

    expect(seen.submitted).toEqual([])
    expect(seen.filled).toEqual([ROUGH])
    expect(seen.logs.join('\n')).toContain('529')
  })

  test('with review on, Edit first puts the upgrade in the box', { options: { review: 'review' } }, async ($, on) => {
    const seen = world(on, { reviewAnswer: 'Edit first' })

    await $.session.start(START)
    await better($, ROUGH)
    await seen.clock.settle()

    expect(seen.asked.map((q: { header: string }) => q.header)).toEqual(['1/2 Audience', '2/2 Length', 'Review'])
    expect(seen.logs.join('\n')).toContain(UPGRADED)
    expect(seen.submitted).toEqual([])
    expect(seen.filled).toEqual([UPGRADED])
  })

  test('with review on, Send my original sends the original', { options: { review: 'review' } }, async ($, on) => {
    const seen = world(on, { reviewAnswer: 'Send my original' })

    await $.session.start(START)
    await better($, ROUGH)
    await seen.clock.settle()

    expect(seen.submitted.map(one => one.text)).toEqual([ROUGH])
  })

  test('maxQuestions limits the dialog', { options: { maxQuestions: '1' } }, async ($, on) => {
    const seen = world(on)

    await $.session.start(START)
    await better($, ROUGH)
    await seen.clock.settle()

    expect(seen.asked.length).toBe(1)
    expect(seen.asked[0].header).toBe('Audience')
  })
})

describe('automatic mode', () => {
  test('off by default: prompts go straight through', async ($, on) => {
    const seen = world(on)

    await $.session.start(START)

    const result = await $.prompt.submit(typed(ROUGH))
    expect(result.text).toBe(ROUGH)
    expect(seen.asked).toEqual([])
  })

  test('on: a rough prompt is taken, upgraded and sent; replies and ">" pass', async ($, on) => {
    const seen = world(on)

    await $.session.start(START)
    await better($, 'on')

    const taken = await $.prompt.submit(typed(ROUGH))
    expect(typeof (taken as { drop?: string }).drop).toBe('string')

    await seen.clock.settle()
    expect(seen.submitted.map(one => one.text)).toContain(UPGRADED)

    const reply = await $.prompt.submit(typed('yes'))
    expect(reply.text).toBe('yes')

    const stripped = await $.prompt.submit(typed('> exactly this'))
    expect(stripped.text).toBe('exactly this')

    await better($, 'off')
    const after = await $.prompt.submit(typed(ROUGH))
    expect(after.text).toBe(ROUGH)
  })

  test('bare /better shows how to use it', async ($, on) => {
    world(on)

    await $.session.start(START)

    const said = await better($, '')
    expect(said.text).toContain('/better on | off')
  })
})
