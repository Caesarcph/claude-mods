import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Answer, HistoryItem, Run } from '../types'
import {
  QUESTION_SYSTEM,
  REWRITE_SYSTEM,
  classify,
  countWords,
  makeId,
  newRun,
  parseQuestions,
  parseRewrite,
  questionPrompt,
  readHistory,
  rewritePrompt,
  withHistory,
} from './logic'
import type { Verdict } from './logic'
import { draw } from './view'
import type { Actions, Kit } from './view'

type Dollar = EngineInterface

const PANE = 'prompt-upgrade'
const FAST_MODEL = 'haiku'
const WRITE_MODEL = 'sonnet'

// What a drawing reads. Written only from handlers and events, never while drawing.
const runAtom = atom({ plugin: 'prompt-upgrade', key: 'run' } as const, null)
const historyAtom = atom({ plugin: 'prompt-upgrade', key: 'history' } as const, [])
const viewAtom = atom({ plugin: 'prompt-upgrade', key: 'view' } as const, 'run')
const autoAtom = atom({ plugin: 'prompt-upgrade', key: 'isAuto' } as const, false)

type Failed = Extract<Awaited<ReturnType<Dollar['model']['complete']>>, { isAnswered: false }>

function whyFailed(res: Failed): string {
  if (res.reason === 'api-error') {
    return `The model service answered with an error${res.status === null ? '' : ` (${res.status})`}.`
  }

  if (res.reason === 'empty-reply') {
    return 'The model sent back an empty reply.'
  }

  return 'The model took too long to answer.'
}

// Module variables start over on a reload; the run itself lives in `$.state`.
let inflight = ''
let stop: AbortController | null = null
let seq = 0

const openPane = ($: Dollar) =>
  $.ui.open({ id: PANE, title: 'Prompt Upgrade', focus: true, closeOnEscape: true, rows: 28, columns: 110 })

/** Work that must outlive the dispatch that asked for it runs from a timer. */
const defer = ($: Dollar, work: () => Promise<unknown>) => {
  $.clock.after(0, () => {
    void work().catch(() => undefined)
  })
}

const go = (work: () => Promise<unknown>) => {
  void work().catch(() => undefined)
}

const abortWork = () => {
  if (stop !== null) {
    stop.abort()
  }

  stop = null
  inflight = ''
}

const patch = ($: Dollar, id: string, change: (run: Run) => Run) =>
  update($, runAtom, current => (current !== null && current.id === id ? change(current) : current))

/** Puts words back in the prompt box without losing what is already there. */
const putBack = async ($: Dollar, text: string) => {
  const box = await $.prompt.read()
  const have = box.text.trim()

  if (have.includes(text.trim())) {
    return
  }

  await $.prompt.fill({ text: have === '' ? text : `${box.text}\n\n${text}`, mode: 'replace' })
}

const remember = async ($: Dollar, id: string) => {
  const run = await read($, runAtom)

  if (run === null || run.id !== id || run.upgraded === '') {
    return
  }

  const item: HistoryItem = {
    id,
    at: await $.clock.now(),
    original: run.original,
    upgraded: run.upgraded,
    added: run.added,
    wordsBefore: countWords(run.original),
    wordsAfter: countWords(run.upgraded),
  }
  const list = withHistory(await read($, historyAtom), item)

  await update($, historyAtom, () => list)

  try {
    await $.store.set('history', list)
  } catch {
    // The upgrade still stands; only the saved history missed this one.
  }
}

const fail = ($: Dollar, id: string, step: 'questions' | 'rewrite', text: string) =>
  patch($, id, run => ({ ...run, phase: 'error', failedStep: step, errorText: text }))

// --- The two model steps ---------------------------------------------

const stepRewrite = async ($: Dollar, id: string): Promise<void> => {
  const key = `${id}:rewrite`
  const run = await read($, runAtom)

  if (inflight === key || run === null || run.id !== id || run.phase !== 'rewrite') {
    return
  }

  inflight = key
  const control = new AbortController()
  stop = control

  try {
    const given = run.questions.flatMap(question => {
      const one = run.answers[question.id]

      return one !== undefined && one.kind !== 'skip' ? [{ question: question.text, answer: one.text }] : []
    })
    const res = await $.model.complete(
      {
        model: WRITE_MODEL,
        system: REWRITE_SYSTEM,
        prompt: rewritePrompt(run.original, given),
        maxTokens: 2000,
        timeoutMs: 60000,
      },
      { signal: control.signal },
    )

    if (control.signal.aborted) {
      return
    }

    const now = await read($, runAtom)

    if (now === null || now.id !== id || now.phase !== 'rewrite') {
      return
    }

    if (!res.isAnswered) {
      await fail($, id, 'rewrite', whyFailed(res))

      return
    }

    const out = parseRewrite(res.text)

    if (out === null) {
      await fail($, id, 'rewrite', 'The upgrade came back in a shape that could not be read.')

      return
    }

    await patch($, id, current => ({
      ...current,
      phase: 'review',
      upgraded: out.prompt,
      added: out.added,
      isEditing: false,
      note: '',
      isNoteWarning: false,
    }))
    await remember($, id)
  } catch {
    await fail($, id, 'rewrite', 'Something went wrong while writing the upgrade.')
  } finally {
    if (inflight === key) {
      inflight = ''
    }

    if (stop === control) {
      stop = null
    }
  }
}

const stepQuestions = async ($: Dollar, id: string): Promise<void> => {
  const key = `${id}:questions`
  const run = await read($, runAtom)

  if (inflight === key || run === null || run.id !== id || run.phase !== 'reading') {
    return
  }

  inflight = key
  const control = new AbortController()
  stop = control
  let isNext = false

  try {
    const res = await $.model.complete(
      {
        model: FAST_MODEL,
        system: QUESTION_SYSTEM,
        prompt: questionPrompt(run.original),
        maxTokens: 800,
        effort: 'low',
        timeoutMs: 30000,
      },
      { signal: control.signal },
    )

    if (control.signal.aborted) {
      return
    }

    const now = await read($, runAtom)

    if (now === null || now.id !== id || now.phase !== 'reading') {
      return
    }

    if (!res.isAnswered) {
      await fail($, id, 'questions', whyFailed(res))

      return
    }

    const questions = parseQuestions(res.text)

    if (questions === null) {
      await fail($, id, 'questions', 'The questions came back in a shape that could not be read.')

      return
    }

    if (questions.length === 0) {
      await patch($, id, current => ({ ...current, phase: 'rewrite' }))
      isNext = true
    } else {
      await patch($, id, current => ({ ...current, phase: 'questions', questions }))
    }
  } catch {
    await fail($, id, 'questions', 'Something went wrong while reading your prompt.')
  } finally {
    if (inflight === key) {
      inflight = ''
    }

    if (stop === control) {
      stop = null
    }
  }

  if (isNext) {
    await stepRewrite($, id)
  }
}

// --- Moving a run along ----------------------------------------------

const startRun = async ($: Dollar, original: string, phase: 'reading' | 'compose') => {
  abortWork()
  seq += 1
  const id = makeId(await $.clock.now(), seq)

  await update($, runAtom, () => newRun(id, original, phase))
  await update($, viewAtom, () => 'run')

  return id
}

/** Opens the pane; if nothing can draw it, hands the person's words back. */
const showPane = ($: Dollar, id: string) => {
  void openPane($)
    .then(async placed => {
      if (placed.isPlaced) {
        return
      }

      const run = await read($, runAtom)

      if (run === null || run.id !== id) {
        return
      }

      abortWork()
      await update($, runAtom, () => null)

      if (run.original !== '') {
        await putBack($, run.original)
      }

      $.ui.toast('Prompt Upgrade needs a wider window. Your prompt is back in the box.')
    })
    .catch(() => undefined)
}

const beginRewrite = async ($: Dollar, id: string) => {
  await patch($, id, run => (run.phase === 'questions' ? { ...run, phase: 'rewrite', otherFor: null } : run))
  const run = await read($, runAtom)

  if (run !== null && run.id === id && run.phase === 'rewrite') {
    defer($, () => stepRewrite($, id))
  }
}

const answer = async ($: Dollar, id: string, questionId: string, given: Answer) => {
  await patch($, id, run =>
    run.phase === 'questions'
      ? { ...run, answers: { ...run.answers, [questionId]: given }, otherFor: null, otherDraft: '' }
      : run,
  )
  const run = await read($, runAtom)

  if (
    run !== null &&
    run.id === id &&
    run.phase === 'questions' &&
    run.questions.every(question => run.answers[question.id] !== undefined)
  ) {
    await beginRewrite($, id)
  }
}

const closePane = async ($: Dollar) => {
  await update($, viewAtom, () => 'run')
  await $.ui.close({ id: PANE })
}

const cancel = async ($: Dollar) => {
  const run = await read($, runAtom)

  abortWork()
  await update($, runAtom, () => null)
  await closePane($)

  if (run !== null && run.original !== '') {
    await putBack($, run.original)
  }
}

const submitText = async ($: Dollar, text: string) => {
  abortWork()
  await update($, runAtom, () => null)
  await closePane($)

  try {
    await $.prompt.submit({ text, asUser: true })
  } catch {
    await putBack($, text)
  }
}

const runIt = async ($: Dollar, edited?: string) => {
  const run = await read($, runAtom)

  if (run === null || run.phase !== 'review') {
    return
  }

  const text = (edited ?? run.upgraded).trim()

  if (text === '') {
    return
  }

  if (text !== run.upgraded) {
    await patch($, run.id, current => ({ ...current, upgraded: text }))
  }

  await remember($, run.id)
  await submitText($, text)
}

const retry = async ($: Dollar) => {
  const run = await read($, runAtom)

  if (run === null || run.phase !== 'error' || run.failedStep === null) {
    return
  }

  const step = run.failedStep
  const id = run.id

  await patch($, id, current => ({
    ...current,
    phase: step === 'questions' ? 'reading' : 'rewrite',
    failedStep: null,
    errorText: '',
  }))
  defer($, () => (step === 'questions' ? stepQuestions($, id) : stepRewrite($, id)))
}

const reopen = async ($: Dollar, id: string) => {
  const item = (await read($, historyAtom)).find(one => one.id === id)

  if (item === undefined) {
    return
  }

  abortWork()
  await update($, runAtom, () => ({
    ...newRun(item.id, item.original, 'review'),
    upgraded: item.upgraded,
    added: item.added,
  }))
  await update($, viewAtom, () => 'run')
}


export const register: Register = on => {
  // --- Setting up, and picking a run back up after a reload -------------

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'better',
        description: 'Upgrade a rough prompt: /better <prompt>, on, off, history',
        argumentHint: '[prompt | on | off | history]',
      })

      const isAuto = (await $.store.get('auto')) === true
      const list = readHistory(await $.store.get('history'))

      await update($, autoAtom, () => isAuto)
      await update($, historyAtom, () => list)

      const run = await read($, runAtom)

      if (run !== null) {
        void openPane($).catch(() => undefined)

        if (run.phase === 'reading') {
          defer($, () => stepQuestions($, run.id))
        } else if (run.phase === 'rewrite') {
          defer($, () => stepRewrite($, run.id))
        }
      }
    } catch {
      // The command is still there if registering got that far.
    }

    return next(e)
  })

  // --- The command ------------------------------------------------------

  on('command.run', { command: 'better' }, async ($, e) => {
    try {
      const args = e.args.trim()
      const word = args.toLowerCase()

      if (word === 'on' || word === 'off') {
        const isAuto = word === 'on'

        await $.store.set('auto', isAuto)
        await update($, autoAtom, () => isAuto)

        return {
          text: isAuto
            ? 'Automatic mode is on. Prompts you type will open in Prompt Upgrade before they are sent.'
            : 'Automatic mode is off. Prompts are sent as you type them.',
        }
      }

      if (word === 'history') {
        const list = await read($, historyAtom)

        if (list.length === 0) {
          return { text: 'No upgrades yet. Try /better followed by a rough prompt.' }
        }

        await update($, viewAtom, () => 'history')
        void openPane($).catch(() => undefined)

        return { text: `Showing your last ${list.length} upgrade${list.length === 1 ? '' : 's'} in the pane.` }
      }

      if (args === '') {
        const active = await read($, runAtom)

        if (active !== null) {
          await update($, viewAtom, () => 'run')
          void openPane($).catch(() => undefined)

          return { text: 'Prompt Upgrade is open in the pane.' }
        }

        const id = await startRun($, '', 'compose')

        showPane($, id)

        return { text: 'Type your rough prompt in the pane.' }
      }

      const id = await startRun($, args, 'reading')

      showPane($, id)
      defer($, () => stepQuestions($, id))

      return { text: 'Upgrading your prompt in the pane. Nothing runs until you press Run.' }
    } catch (error) {
      const why = error instanceof Error ? error.message : 'unknown error'

      return { text: `Prompt Upgrade could not start (${why}). Your prompt was not sent.` }
    }
  }).catch(() => ({ text: 'Prompt Upgrade hit a problem and did nothing. Your prompt was not sent.' }))

  // --- Automatic mode ---------------------------------------------------

  on('prompt.submit', async ($, e, next) => {
    let verdict: Verdict = { kind: 'pass' }

    try {
      if ((await $.store.get('auto')) === true) {
        verdict = classify(e)
      }

      if (verdict.kind === 'intercept' && (await read($, runAtom)) !== null) {
        // One upgrade at a time: a prompt typed meanwhile goes through untouched.
        verdict = { kind: 'pass' }
      }

      if (verdict.kind === 'intercept') {
        const id = await startRun($, e.text, 'reading')
        const placed = await openPane($)

        if (!placed.isPlaced) {
          abortWork()
          await update($, runAtom, () => null)
          defer($, () => putBack($, e.text))

          return { drop: 'Prompt Upgrade needs a wider window, so your prompt is back in the box.' }
        }

        defer($, () => stepQuestions($, id))

        return { drop: 'Upgrading your prompt in the pane. Nothing runs until you press Run.' }
      }
    } catch {
      verdict = { kind: 'pass' }
    }

    if (verdict.kind === 'strip') {
      return next({ ...e, text: verdict.text })
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // --- Closing the pane by hand never loses the prompt -------------------

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') {
      try {
        const run = await read($, runAtom)
        const view = await read($, viewAtom)

        if (view === 'history') {
          await update($, viewAtom, () => 'run')
        } else if (run !== null) {
          abortWork()
          await update($, runAtom, () => null)

          if (run.original !== '') {
            await putBack($, run.original)
          }
        }
      } catch {
        // Closing still goes ahead.
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // --- Drawing ------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Box, Text } = $.ui.resolve(e)

      return (
        <Box>
          <Text>Prompt Upgrade needs the terminal or the desktop app.</Text>
        </Box>
      )
    }

    const kit = $.ui.resolve(e) as unknown as Kit
    const run = await read($, runAtom)
    const view = await read($, viewAtom)
    const history = await read($, historyAtom)
    const isAuto = await read($, autoAtom)

    const act: Actions = {
      submitCompose: text => {
        const original = text.trim()

        if (original === '' || run === null) {
          return
        }

        go(async () => {
          await update($, runAtom, current =>
            current !== null && current.phase === 'compose' ? newRun(current.id, original, 'reading') : current,
          )
          await stepQuestions($, run.id)
        })
      },
      pickOption: (questionId, text) => {
        if (run !== null) {
          go(() => answer($, run.id, questionId, { kind: 'option', text }))
        }
      },
      openOther: questionId => {
        if (run !== null) {
          const have = run.answers[questionId]

          go(() =>
            patch($, run.id, current => ({
              ...current,
              otherFor: questionId,
              otherDraft: have !== undefined && have.kind === 'other' ? have.text : '',
            })),
          )
        }
      },
      typeOther: text => {
        if (run !== null) {
          go(() => patch($, run.id, current => ({ ...current, otherDraft: text })))
        }
      },
      submitOther: (questionId, text) => {
        const typed = text.trim()

        if (run !== null && typed !== '') {
          go(() => answer($, run.id, questionId, { kind: 'other', text: typed }))
        }
      },
      skipQuestion: questionId => {
        if (run !== null) {
          go(() => answer($, run.id, questionId, { kind: 'skip', text: '' }))
        }
      },
      skipRest: () => {
        if (run !== null) {
          go(() => beginRewrite($, run.id))
        }
      },
      runIt: () => go(() => runIt($)),
      toggleEdit: () => {
        if (run !== null) {
          go(async () => {
            await patch($, run.id, current => ({ ...current, isEditing: !current.isEditing }))
            await remember($, run.id)
          })
        }
      },
      typeUpgrade: text => {
        if (run !== null) {
          go(() => patch($, run.id, current => ({ ...current, upgraded: text })))
        }
      },
      runEdited: text => go(() => runIt($, text)),
      copy: surface => {
        if (run !== null) {
          go(async () => {
            const result = await $.ui.copy({ text: run.upgraded, surface })

            await patch($, run.id, current => ({
              ...current,
              note: result.isCopied ? 'Copied the upgrade.' : 'Copying is not available here.',
              isNoteWarning: !result.isCopied,
            }))
          })
        }
      },
      cancel: () => go(() => cancel($)),
      retry: () => go(() => retry($)),
      sendOriginal: () => {
        if (run !== null) {
          go(() => submitText($, run.original))
        }
      },
      openHistoryItem: id => go(() => reopen($, id)),
      closeHistory: () => {
        go(async () => {
          const active = await read($, runAtom)

          if (active === null) {
            await closePane($)
          } else {
            await update($, viewAtom, () => 'run')
          }
        })
      },
    }

    return draw({
      kit,
      cols: Math.max(24, e.props.bodyColumns),
      run,
      view,
      history,
      isAuto,
      act,
    })
  })
}
