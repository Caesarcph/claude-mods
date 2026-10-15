import { describe, expect, mock, test } from 'claude-code/testing'

import { isShortReply, judgeByRules, parseJudge, resolveModel, sizeOf } from './hooks/logic'

const SESSION_MODEL = 'claude-sonnet-5-5'
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const COMPOSER = { kind: 'composer' } as const

const EASY = 'rename the variable foo to bar in utils.ts'
const MEDIUM = 'write a function that parses a CSV line and handles quoted commas'
const HARD =
  'Refactor the auth module to use JWT and update the tests across the codebase. Then check the session handling for a race condition.'
const EXPERT = [
  'Design a migration of our monolith to services, from scratch, with a plan for the database schema,',
  'concurrency and security risks. Think carefully and step by step:',
  '1. map the modules',
  '2. define the service boundaries',
  '3. plan the data migration',
  '4. handle the race conditions',
  '5. design the rollout',
  '6. write the rollback plan',
].join('\n')

/** The world beneath the mod: the session's own engine, answered from memory. */
function world(on: any, options: { judgeReply?: string; emptyForOtherModels?: boolean; failWith?: string; engine?: any } = {}) {
  mock.store(on)

  const seen = {
    steps: [] as { model: string; effort: unknown; agentId?: string }[],
    statuses: [] as (string | undefined)[],
    judged: 0,
  }

  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'auto-model' } }))
  on('session.model', () => ({ value: SESSION_MODEL }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('ui.status', (_: unknown, e: { text?: string }) => {
    seen.statuses.push(e.text)

    return { value: undefined }
  })
  on('model.complete', () => {
    seen.judged += 1

    return {
      value: options.judgeReply === undefined
        ? { isAnswered: false, reason: 'empty-reply', usage: USAGE }
        : { isAnswered: true, text: options.judgeReply, usage: USAGE },
    }
  })
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number; model: string; effort?: unknown; agentId?: string }) {
    seen.steps.push({ model: e.model, effort: e.effort, agentId: e.agentId })

    // A model the provider does not serve: nothing answers, no usage, no stop reason.
    if (options.emptyForOtherModels && e.model !== SESSION_MODEL) {
      if (options.failWith !== undefined) {
        // The engine records the API's error as an assistant row with no role.
        await options.engine.session.append({
          message: { type: 'assistant', content: [{ type: 'text', text: options.failWith }] },
          door: 'response',
          origin: { kind: 'engine' },
          uuid: `err-${e.index}`,
        })
      }

      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
    }

    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage: null,
    }
  })

  return seen
}

const startTurn = ($: any, turnId: string, text: string) => $.turn.start({ turnId, text })

const step = async ($: any, turnId: string, extra: Record<string, unknown> = {}) => {
  const stream = $.turn.step({
    turnId,
    index: 0,
    model: SESSION_MODEL,
    effort: 'medium',
    messageCount: 2,
    ...extra,
  })

  for await (const chunk of stream) {
    void chunk
  }

  return stream.result
}

const command = ($: any, args: string) =>
  $.command.run({
    command: 'auto-model',
    args,
    origin: COMPOSER,
    presentation: { isFullscreen: true, columns: 120 },
  })

describe('judging difficulty by rules', () => {
  test('easy, medium, hard and expert prompts land in their tiers', () => {
    expect(judgeByRules(EASY).tier).toBe('easy')
    expect(judgeByRules(MEDIUM).tier).toBe('medium')
    expect(judgeByRules(HARD).tier).toBe('hard')
    expect(judgeByRules(EXPERT).tier).toBe('expert')
  })

  test('Chinese prompts are judged too', () => {
    expect(judgeByRules('把变量名 foo 重命名成 bar').tier).toBe('easy')
    expect(judgeByRules('实现一个解析 CSV 的函数，要处理带引号的逗号').tier).toBe('medium')
    expect(judgeByRules('重构整个项目的鉴权模块，排查并发导致的竞态问题，并更新所有测试').tier).not.toBe('easy')
  })

  test('asking to think hard raises it and asking for quick lowers it', () => {
    const plain = judgeByRules('write a function that merges two sorted lists')
    const careful = judgeByRules('write a function that merges two sorted lists, think carefully and thoroughly')
    const quick = judgeByRules('just write a function that merges two sorted lists')

    expect(careful.score).toBeGreaterThan(plain.score)
    expect(quick.score).toBeLessThan(plain.score)
  })

  test('short replies carry no difficulty of their own', () => {
    expect(isShortReply('yes')).toBe(true)
    expect(isShortReply('continue')).toBe(true)
    expect(isShortReply('ok do it')).toBe(true)
    expect(isShortReply('继续')).toBe(true)
    expect(isShortReply('好的，继续做吧')).toBe(true)
    expect(isShortReply('可以，开始吧')).toBe(true)
    expect(isShortReply('okay')).toBe(true)
    expect(isShortReply('nothing works anymore')).toBe(false)
    expect(isShortReply('refactor the whole auth module')).toBe(false)
    expect(sizeOf('一二三四五六七八九十')).toBeGreaterThan(4)
  })

  test('the model judge reply is read, and nonsense is not', () => {
    expect(parseJudge('{"tier":"hard","why":"multi-file debugging"}')).toEqual({ tier: 'hard', why: 'multi-file debugging' })
    expect(parseJudge('I think it is hard')).toBe(null)
  })
})

describe('switching the model and effort', () => {
  test('each step of a turn is sent with the tier\'s model and effort', async ($, on) => {
    const seen = world(on)

    await $.session.start(START)

    await startTurn($, 't-easy', EASY)
    await step($, 't-easy')
    await startTurn($, 't-hard', HARD)
    await step($, 't-hard')
    await startTurn($, 't-expert', EXPERT)
    await step($, 't-expert')

    expect(seen.steps.map(one => [one.model, one.effort])).toEqual([
      ['claude-haiku-5-5', 'high'],
      ['claude-opus-5-5', 'high'],
      ['claude-fable-5-1', 'high'],
    ])
  })

  test('a turn keeps one model across its steps, tool results included', async ($, on) => {
    const seen = world(on)

    await $.session.start(START)
    await startTurn($, 't1', MEDIUM)
    await step($, 't1', { index: 0 })
    await step($, 't1', { index: 1, messageCount: 4 })

    expect(seen.steps.map(one => one.model)).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5'])
  })

  test('a short reply keeps the tier of the turn before it', async ($, on) => {
    const seen = world(on)

    await $.session.start(START)
    await startTurn($, 't1', HARD)
    await step($, 't1')
    await startTurn($, 't2', 'continue')
    await step($, 't2')

    expect(seen.steps.map(one => one.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
  })

  test('a subagent starting mid-turn leaves the main turn\'s plan alone', async ($, on) => {
    const seen = world(on)

    await $.session.start(START)
    await startTurn($, 't1', HARD)
    await $.turn.start({ turnId: 'sub-1', text: 'just list the files', agentId: 'agent-1' })
    await step($, 't1', { index: 1 })

    expect(seen.steps[0]?.model).toBe('claude-opus-5-5')
  })

  test('a "list" inside a real task is not a small task', () => {
    expect(judgeByRules('implement a linked list with insert and delete').tier).not.toBe('easy')
    expect(judgeByRules('list the files in src').tier).toBe('easy')
  })

  test('subagent steps are left as they are', async ($, on) => {
    const seen = world(on)

    await $.session.start(START)
    await startTurn($, 't1', HARD)
    await step($, 't1', { agentId: 'agent-1' })

    expect(seen.steps[0]).toEqual({ model: SESSION_MODEL, effort: 'medium', agentId: 'agent-1' })
  })

  test('/auto-model off leaves the session\'s own model and effort alone, on turns it back', async ($, on) => {
    const seen = world(on)

    await $.session.start(START)
    const off = await command($, 'off')
    expect(off.text).toContain('off')

    await startTurn($, 't1', HARD)
    await step($, 't1')
    expect(seen.steps[0]).toEqual({ model: SESSION_MODEL, effort: 'medium', agentId: undefined })

    const turnedOn = await command($, 'on')
    expect(turnedOn.text).toContain('is on')

    await startTurn($, 't2', HARD)
    await step($, 't2')
    expect(seen.steps[1]?.model).toBe('claude-opus-5-5')
  })
})

describe('options', () => {
  test('modelHard and effortHard are read from the options', { options: { modelHard: 'big-model', effortHard: 'max' } }, async ($, on) => {
    const seen = world(on)

    await $.session.start(START)
    await startTurn($, 't1', HARD)
    await step($, 't1')

    expect(seen.steps[0]?.model).toBe('big-model')
    expect(seen.steps[0]?.effort).toBe('max')
  })

  test('with the model judge on, its tier is used', { options: { judge: 'model' } }, async ($, on) => {
    const seen = world(on, { judgeReply: '{"tier":"expert","why":"risky migration"}' })

    await $.session.start(START)
    await startTurn($, 't1', EASY)
    await step($, 't1')

    expect(seen.judged).toBe(1)
    expect(seen.steps[0]?.model).toBe('claude-fable-5-1')
    expect(seen.steps[0]?.effort).toBe('high')
  })

  test('with the model judge on, try uses it too, and a tiny prompt skips it', { options: { judge: 'model' } }, async ($, on) => {
    const seen = world(on, { judgeReply: '{"tier":"hard","why":"needs investigation"}' })

    await $.session.start(START)

    const tried = await command($, `try ${EASY}`)
    expect(tried.text).toContain('hard (model judge: needs investigation)')
    expect(seen.judged).toBe(1)

    await startTurn($, 't1', 'fix typo')
    await step($, 't1')
    expect(seen.judged).toBe(1)

    const odd = await command($, 'tryhard')
    expect(odd.text).toContain('auto-model is on')
  })

  test('with the model judge on and failing, the rules answer', { options: { judge: 'model' } }, async ($, on) => {
    const seen = world(on)

    await $.session.start(START)
    await startTurn($, 't1', EASY)
    await step($, 't1')

    expect(seen.judged).toBe(1)
    expect(seen.steps[0]?.model).toBe('claude-haiku-5-5')
  })
})

describe('the command', () => {
  test('status lists the tiers and the last decision; try explains without sending', async ($, on) => {
    const seen = world(on)

    await $.session.start(START)
    await startTurn($, 't1', HARD)

    const status = await command($, '')
    expect(status.text).toContain('auto-model is on')
    expect(status.text).toContain('hard')
    expect(status.text).toContain('opus')
    expect(status.text).toContain('Last turn: hard')
    expect(status.text).toContain('claude-opus-5-5')

    const tried = await command($, `try ${EASY}`)
    expect(tried.text).toContain('easy')
    expect(tried.text).toContain('haiku · high')
    expect(seen.steps).toEqual([])
  })
})

describe('changing a tier from the command line', () => {
  test('/auto-model set changes model and effort for the next turn', async ($, on) => {
    const seen = world(on)

    await $.session.start(START)

    const said = await command($, 'set hard claude-opus-x max')
    expect(said.text).toContain('hard → claude-opus-x · max')

    await startTurn($, 't1', HARD)
    await step($, 't1')

    expect(seen.steps[0]?.model).toBe('claude-opus-x')
    expect(seen.steps[0]?.effort).toBe('max')
  })

  test('set with only an effort keeps the model, and reset puts it back', async ($, on) => {
    const seen = world(on)

    await $.session.start(START)
    await command($, 'set easy medium')
    await startTurn($, 't1', EASY)
    await step($, 't1')
    expect(seen.steps[0]).toEqual({ model: 'claude-haiku-5-5', effort: 'medium', agentId: undefined })

    const back = await command($, 'reset easy')
    expect(back.text).toContain('easy')
    await startTurn($, 't2', EASY)
    await step($, 't2')
    expect(seen.steps[1]).toEqual({ model: 'claude-haiku-5-5', effort: 'high', agentId: undefined })
  })

  test('bad input is explained and changes nothing', async ($, on) => {
    const seen = world(on)

    await $.session.start(START)

    const wrong = await command($, 'set impossible opus')
    expect(wrong.text).toContain('Usage')
    const nothing = await command($, 'set hard')
    expect(nothing.text).toContain('Usage')

    await startTurn($, 't1', HARD)
    await step($, 't1')
    expect(seen.steps[0]?.model).toBe('claude-opus-5-5')
  })
})

describe('sending a model id the API takes', () => {
  test('aliases become ids, and a full id is kept as written', () => {
    expect(resolveModel('haiku', 'claude-sonnet-5-5')).toBe('claude-haiku-5-5')
    expect(resolveModel('opus', 'claude-sonnet-5-5')).toBe('claude-opus-5-5')
    expect(resolveModel('Sonnet', 'claude-sonnet-5-5')).toBe('claude-sonnet-5-5')
    expect(resolveModel('sonnet', 'claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(resolveModel('claude-opus-4-8', 'claude-sonnet-5-5')).toBe('claude-opus-4-8')
    expect(resolveModel('my-gateway-model', '')).toBe('my-gateway-model')
  })

  test('the API is never sent a bare alias', async ($, on) => {
    const seen = world(on)

    await $.session.start(START)
    await command($, 'set easy haiku')
    await startTurn($, 't1', EASY)
    await step($, 't1')

    expect(seen.steps[0]?.model).toBe('claude-haiku-5-5')
  })

  test('a step that no model answered is sent again as the session had it', async ($, on) => {
    const seen = world(on, { emptyForOtherModels: true })

    await $.session.start(START)
    await command($, 'set easy claude-haiku-5-5')
    await startTurn($, 't1', EASY)
    await step($, 't1')
    await step($, 't1', { index: 1 })

    // Tried the haiku id, got nothing back, sent the session's own; the next step goes straight there.
    expect(seen.steps.map(one => one.model)).toEqual(['claude-haiku-5-5', SESSION_MODEL, SESSION_MODEL])
    const status = await command($, '')
    expect(status.text).toContain('fell back')
  })
})

describe('when the chosen model fails', () => {
  test('the API\'s reason is shown, and a model it will not serve is skipped for the session', async ($, on) => {
    const seen = world(on, {
      emptyForOtherModels: true,
      failWith: "There's an issue with the selected model (claude-haiku-5-5). It may not exist or you may not have access to it.",
      engine: $,
    })

    await $.session.start(START)
    await command($, 'set easy haiku')
    await startTurn($, 't1', EASY)
    await step($, 't1')

    expect(seen.statuses.at(-1)).toContain('claude-haiku-5-5 failed (There\'s an issue with the selected model')

    await startTurn($, 't2', EASY)
    await step($, 't2')

    // Tried once, then the session's own model from the next turn on.
    expect(seen.steps.map(one => one.model)).toEqual(['claude-haiku-5-5', SESSION_MODEL, SESSION_MODEL])

    const status = await command($, '')
    expect(status.text).toContain('Skipped this session: claude-haiku-5-5')
  })

  test('a failure that can pass is retried on the next turn', async ($, on) => {
    const seen = world(on, { emptyForOtherModels: true, failWith: 'API Error: Repeated 529 Overloaded errors', engine: $ })

    await $.session.start(START)
    await command($, 'set easy haiku')
    await startTurn($, 't1', EASY)
    await step($, 't1')
    await startTurn($, 't2', EASY)
    await step($, 't2')

    expect(seen.steps.map(one => one.model)).toEqual(['claude-haiku-5-5', SESSION_MODEL, 'claude-haiku-5-5', SESSION_MODEL])
  })
})
