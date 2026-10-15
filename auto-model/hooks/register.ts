import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Effort, Plan, Tier } from '../types'
import type { TaskMessage } from './logic'
import {
  EFFORTS,
  JUDGE_SYSTEM,
  TIERS,
  asEffort,
  asModel,
  conversationFor,
  harder,
  isFollowUp,
  isShortReply,
  judgeInContext,
  judgePrompt,
  sizeOf,
  parseJudge,
  resolveModel,
  isLasting,
  shortReason,
} from './logic'

type Dollar = EngineInterface

const planAtom = atom({ plugin: 'auto-model', key: 'plan' } as const, null)
const unavailableAtom = atom({ plugin: 'auto-model', key: 'unavailable' } as const, {})

// The error row the engine appends when a step's request fails (an assistant row
// with no role, never sent to the model), kept for the step that is waiting on it.
let lastError = ''

const DEFAULTS: Record<Tier, { model: string; effort: Effort }> = {
  easy: { model: 'haiku', effort: 'high' },
  medium: { model: 'sonnet', effort: 'high' },
  hard: { model: 'opus', effort: 'high' },
  expert: { model: 'fable', effort: 'high' },
}

/** Choices made with `/auto-model set`, kept across sessions; they win over the options. */
type Overrides = Partial<Record<Tier, { model?: string; effort?: Effort }>>

const loadOverrides = async ($: Dollar): Promise<Overrides> => {
  const raw = await $.store.get('choices')
  const found: Overrides = {}

  if (raw === null || typeof raw !== 'object') {
    return found
  }

  for (const tier of TIERS) {
    const one = (raw as Record<string, unknown>)[tier]

    if (one !== null && typeof one === 'object') {
      const { model, effort } = one as { model?: unknown; effort?: unknown }

      found[tier] = {
        ...(typeof model === 'string' && model.trim() !== '' ? { model: model.trim() } : {}),
        ...(typeof effort === 'string' && (EFFORTS as readonly string[]).includes(effort) ? { effort: effort as Effort } : {}),
      }
    }
  }

  return found
}

const cap = (tier: Tier) => tier[0]!.toUpperCase() + tier.slice(1)

/**
 * What a tier asks for: `/auto-model set` first, then the options, then the
 * defaults. The options are `modelEasy`, `effortEasy` and so on: 0.1's
 * `easyModel` keys are not read, so values an install saved from the old
 * defaults no longer hide the new ones.
 */
const choiceFor = (
  options: PluginOptions,
  overrides: Overrides,
  tier: Tier,
): { model: string; effort: Effort } => ({
  model: asModel(overrides[tier]?.model, asModel(options[`model${cap(tier)}`], DEFAULTS[tier].model)),
  effort: asEffort(overrides[tier]?.effort, asEffort(options[`effort${cap(tier)}`], DEFAULTS[tier].effort)),
})

const describeChoice = (options: PluginOptions, overrides: Overrides, tier: Tier): string => {
  const choice = choiceFor(options, overrides, tier)

  return `${choice.model} · ${choice.effort}`
}

const isEnabled = async ($: Dollar): Promise<boolean> => (await $.store.get('enabled')) !== false

/** The conversation so far, for judging a prompt in context; empty when it cannot be read. */
const readMessages = async ($: Dollar): Promise<TaskMessage[]> => {
  try {
    return await $.session.messages()
  } catch {
    return []
  }
}

/**
 * Decides how hard the work is. The rules judge the prompt with its task in
 * view: a follow-up ("continue", "fix it") is at least as hard as the request
 * it continues. The model judge, when on, reads the conversation too.
 */
const decide = async ($: Dollar, text: string, judgeModel: string, options: PluginOptions, previous: Plan | null) => {
  const messages = await readMessages($)
  const previousTier = previous !== null && previous.isActive ? previous.tier : null
  const byRules = judgeInContext(text, messages, previousTier)

  // No model call where it adds nothing: a bare reply its task already decided,
  // or a prompt of a few words that stands on its own.
  const isTrivial = (isShortReply(text) && byRules.isContinued) || (!isFollowUp(text) && sizeOf(text) < 4)

  if (options['judge'] === 'model' && !isTrivial) {
    try {
      const res = await $.model.complete({
        model: judgeModel,
        system: JUDGE_SYSTEM,
        prompt: judgePrompt(text, conversationFor(messages, text)),
        maxTokens: 80,
        effort: 'low',
        timeoutMs: 5000,
      })
      const verdict = res.isAnswered ? parseJudge(res.text) : null

      if (verdict !== null) {
        // A follow-up never drops below the task it continues.
        const tier = isFollowUp(text) ? harder(verdict.tier, byRules.tier) : verdict.tier

        return {
          tier,
          score: TIERS.indexOf(tier),
          reason: verdict.why === '' ? 'judged by the model' : verdict.why,
          judge: 'model' as const,
        }
      }
    } catch {
      // The rules answer instead.
    }
  }

  return { tier: byRules.tier, score: byRules.score, reason: byRules.reason, judge: 'heuristic' as const }
}

const statusLine = (plan: Plan): string =>
  plan.isFallback
    ? `auto-model: ${plan.model} failed (${plan.failure === '' ? 'no response' : plan.failure}); this turn uses the session's model`
    : `auto-model: ${plan.tier} (${shortReason(plan.reason, 60)}) → ${plan.model} · ${plan.effort}`

const statusText = async ($: Dollar, options: PluginOptions): Promise<string> => {
  const on = await isEnabled($)
  const plan = await read($, planAtom)
  const overrides = await loadOverrides($)
  const lines = [
    `auto-model is ${on ? 'on' : 'off'} (judge: ${options['judge'] === 'model' ? `model, ${asModel(options['judgeModel'], 'haiku')}` : 'heuristic'}).`,
    ...TIERS.map(tier => `  ${tier.padEnd(6)} → ${describeChoice(options, overrides, tier)}`),
  ]

  if (plan !== null && plan.isActive) {
    lines.push(`Last turn: ${plan.tier} (${plan.reason}) → ${plan.model} · ${plan.effort}${plan.isFallback ? `, fell back to the session model: ${plan.failure === '' ? 'no response' : plan.failure}` : ''}.`)
  }

  const unavailable = Object.entries(await read($, unavailableAtom))

  if (unavailable.length > 0) {
    lines.push(`Skipped this session: ${unavailable.map(([model, why]) => `${model} (${why})`).join('; ')}.`)
  }

  lines.push('Change a tier: /auto-model set <easy|medium|hard|expert> <model> [low|medium|high|xhigh|max]. Other commands: on, off, try <prompt>, reset.')

  return lines.join('\n')
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'auto-model',
        description: 'Pick model and thinking effort by prompt difficulty: on, off, set, reset, try <prompt>',
        argumentHint: '[on | off | set <tier> <model> [effort] | reset | try <prompt>]',
      })
    } catch {
      // The hooks below still work without the command.
    }

    return next(e)
  })

  on('command.run', { command: 'auto-model' }, async ($, e) => {
    try {
      const args = e.args.trim()
      const word = args.toLowerCase()

      if (word === 'on' || word === 'off') {
        await $.store.set('enabled', word === 'on')

        if (word === 'off') {
          $.ui.status(undefined)
        }

        return {
          text:
            word === 'on'
              ? 'auto-model is on. Each prompt picks its model and thinking effort by difficulty.'
              : 'auto-model is off. Turns use the model and effort you set yourself.',
        }
      }

      if (word === 'try' || word.startsWith('try ')) {
        const sample = args.slice(3).trim()

        if (sample === '') {
          return { text: 'Usage: /auto-model try <a prompt>. It shows what would be chosen, without sending anything.' }
        }

        // The same judge a real turn uses, the model one included when it is on.
        const verdict = await decide($, sample, asModel(options['judgeModel'], 'haiku'), options, null)
        const overrides = await loadOverrides($)
        const score = verdict.judge === 'model' ? 'model judge' : `score ${verdict.score}`

        return {
          text: `${verdict.tier} (${score}: ${verdict.reason}) → ${describeChoice(options, overrides, verdict.tier)}`,
        }
      }

      if (word === 'reset' || word.startsWith('reset ')) {
        const which = word.slice(5).trim()

        if (which === '' || which === 'all') {
          await $.store.delete('choices')

          return { text: 'All tiers are back to the options and defaults.' }
        }

        if (!(TIERS as readonly string[]).includes(which)) {
          return { text: `Unknown tier "${which}". Use easy, medium, hard or expert.` }
        }

        const kept = await loadOverrides($)

        delete kept[which as Tier]
        await $.store.set('choices', kept)

        return { text: `The ${which} tier is back to the options and defaults.` }
      }

      if (word === 'set' || word.startsWith('set ')) {
        const parts = args.split(/\s+/).slice(1)
        const tier = (parts[0] ?? '').toLowerCase()
        const usage =
          'Usage: /auto-model set <easy|medium|hard|expert> <model> [low|medium|high|xhigh|max]. ' +
          'Examples: set hard opus max, set easy haiku low, set expert max (effort only).'

        if (!(TIERS as readonly string[]).includes(tier) || parts.length < 2) {
          return { text: usage }
        }

        const rest = parts.slice(1)
        const last = (rest[rest.length - 1] ?? '').toLowerCase()
        const hasEffort = (EFFORTS as readonly string[]).includes(last)
        const model = hasEffort ? rest.slice(0, -1).join(' ') : rest.join(' ')
        const kept = await loadOverrides($)
        const before = kept[tier as Tier] ?? {}

        kept[tier as Tier] = {
          ...before,
          ...(model === '' ? {} : { model }),
          ...(hasEffort ? { effort: last as Effort } : {}),
        }
        await $.store.set('choices', kept)

        return {
          text: `${tier} → ${describeChoice(options, kept, tier as Tier)}. It applies from your next prompt.`,
        }
      }

      return { text: await statusText($, options) }
    } catch (error) {
      const why = error instanceof Error ? error.message : 'unknown error'

      return { text: `auto-model could not do that (${why}). Nothing was changed.` }
    }
  }).catch(() => ({ text: 'auto-model hit a problem and did nothing.' }))

  on('turn.start', async ($, e, next) => {
    // A subagent's turn is its own: judging it would replace the main turn's plan mid-turn.
    if (e.agentId !== undefined) {
      return next(e)
    }

    try {
      const previous = await read($, planAtom)

      if (!(await isEnabled($))) {
        await update($, planAtom, () => ({
          turnId: e.turnId,
          tier: 'medium' as const,
          model: '',
          effort: 'medium' as const,
          isActive: false,
          judge: 'heuristic' as const,
          reason: 'off',
          score: 0,
          isFallback: false,
          failure: '',
        }))
        $.ui.status(undefined)
      } else {
        const overrides = await loadOverrides($)
        const judgeModel = asModel(options['judgeModel'], 'haiku')
        const verdict = await decide($, e.text, judgeModel, options, previous)
        const choice = choiceFor(options, overrides, verdict.tier)
        let sessionModel = ''

        try {
          sessionModel = await $.session.model()
        } catch {
          // An alias is then resolved from the known ids alone.
        }

        const model = resolveModel(choice.model, sessionModel)
        // A model that already failed for good this session is not asked again.
        const failed = (await read($, unavailableAtom))[model]
        const plan: Plan = {
          turnId: e.turnId,
          tier: verdict.tier,
          model,
          effort: choice.effort,
          isActive: true,
          judge: verdict.judge,
          reason: verdict.reason,
          score: verdict.score,
          isFallback: failed !== undefined,
          failure: failed ?? '',
        }

        await update($, planAtom, () => plan)
        $.ui.status(statusLine(plan))
      }
    } catch {
      // The turn goes on with the session's own model and effort.
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const plan = await read($, planAtom)

    if (e.agentId !== undefined || plan === null || !plan.isActive || plan.isFallback || plan.turnId !== e.turnId) {
      return yield* next(e)
    }

    lastError = ''

    const stream = next({ ...e, model: plan.model, effort: plan.effort })
    let sent = 0

    try {
      for await (const chunk of stream) {
        sent += 1
        yield chunk
      }

      const result = await stream.result

      // A response always reports usage and a stop reason. Neither, and no tool
      // calls, means no request was answered (a model the provider would not
      // serve): the step is sent again as the session had it.
      if (result.usage !== null || result.stopReason !== null || result.toolUses.length > 0) {
        return result
      }
    } catch (error) {
      if (sent > 0 || next.signal.aborted) {
        throw error
      }
    }

    // Stop switching for the rest of this turn, so it carries on as before;
    // for the rest of the session too when the failure will not pass.
    const failure = shortReason(lastError)
    const fallback: Plan = { ...plan, isFallback: true, failure }

    await update($, planAtom, () => fallback)

    if (isLasting(failure)) {
      await update($, unavailableAtom, current => ({ ...current, [plan.model]: failure }))
    }

    $.ui.status(statusLine(fallback))

    const again = next(e)

    for await (const chunk of again) {
      yield chunk
    }

    return await again.result
  })

  on('session.append', async ($, e, next) => {
    const message = e.message

    if (e.agentId === undefined && e.door === 'response' && message.type === 'assistant' && message.role === undefined) {
      lastError = message.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join(' ')
    }

    return next(e)
  }).catch(($, e, next) => next(e))
}
