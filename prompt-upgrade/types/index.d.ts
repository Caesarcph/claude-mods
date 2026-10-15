/** Where a run is: typing a prompt, reading it, asking, rewriting, reviewing, or stopped on an error. */
export type Phase = 'compose' | 'reading' | 'questions' | 'rewrite' | 'review' | 'error'

export type Question = { id: string; text: string; options: string[] }

/** One answer: a listed option, the person's own words, or a skip. */
export type Answer = { kind: 'option' | 'other' | 'skip'; text: string }

/** The upgrade in progress. Plain data: it survives a reload of the module. */
export type Run = {
  id: string
  original: string
  phase: Phase
  questions: Question[]
  answers: Record<string, Answer>
  /** The question whose free-text field is open, if any. */
  otherFor: string | null
  otherDraft: string
  upgraded: string
  added: string[]
  isEditing: boolean
  /** Which step an error card retries. */
  failedStep: 'questions' | 'rewrite' | null
  errorText: string
  /** One quiet line under the buttons (a copy confirmation). */
  note: string
  /** Whether the note is a warning (amber) rather than good news (green). */
  isNoteWarning: boolean
}

export type HistoryItem = {
  id: string
  at: number
  original: string
  upgraded: string
  added: string[]
  wordsBefore: number
  wordsAfter: number
}

export type PaneView = 'run' | 'history'

declare module 'claude-code' {
  interface PluginState {
    'prompt-upgrade': {
      run: Run | null
      history: HistoryItem[]
      view: PaneView
      isAuto: boolean
    }
  }
}
