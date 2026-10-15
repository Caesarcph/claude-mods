export type Tier = 'easy' | 'medium' | 'hard' | 'expert'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** What was decided for one turn, and why. */
export type Plan = {
  turnId: string
  tier: Tier
  /** The model to ask for; '' when the mod is off for this turn. */
  model: string
  effort: Effort
  /** Whether the steps of this turn are rewritten at all. */
  isActive: boolean
  /** Who judged: the local rules, or the quick model call. */
  judge: 'heuristic' | 'model'
  /** A short, plain reason (the signals that tipped it). */
  reason: string
  score: number
  /** Set once a step had to be sent as the session's own model instead. */
  isFallback: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'auto-model': {
      plan: Plan | null
    }
  }
}
