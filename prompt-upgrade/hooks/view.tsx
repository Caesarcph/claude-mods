import type { Elements, RenderSurface } from 'claude-code'

import type { HistoryItem, PaneView, Run } from '../types'
import { bigNumber, bigWidth, countWords, fit, formatWhen } from './logic'

export type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Input'>

export const COLOR = {
  gold: '#F2C46D',
  hair: '#262B33',
  muted: '#7D8590',
  text: '#E6EDF3',
  green: '#3DD68C',
  amber: '#E3B341',
  ink: '#0D1117',
} as const

/** What a press does. Each one is built by the render hook from its own `$`. */
export type Actions = {
  submitCompose: (text: string) => void
  pickOption: (questionId: string, text: string) => void
  openOther: (questionId: string) => void
  typeOther: (text: string) => void
  submitOther: (questionId: string, text: string) => void
  skipQuestion: (questionId: string) => void
  skipRest: () => void
  runIt: () => void
  toggleEdit: () => void
  typeUpgrade: (text: string) => void
  runEdited: (text: string) => void
  copy: (surface: RenderSurface) => void
  cancel: () => void
  retry: () => void
  sendOriginal: () => void
  openHistoryItem: (id: string) => void
  closeHistory: () => void
}

export type DrawInput = {
  kit: Kit
  cols: number
  run: Run | null
  view: PaneView
  history: HistoryItem[]
  isAuto: boolean
  act: Actions
}

const STEPS = ['YOUR PROMPT', 'QUESTIONS', 'REWRITE', 'REVIEW'] as const

function currentStep(run: Run): number {
  if (run.phase === 'compose' || run.phase === 'reading') {
    return 0
  }

  if (run.phase === 'questions') {
    return 1
  }

  if (run.phase === 'rewrite') {
    return 2
  }

  if (run.phase === 'review') {
    return 3
  }

  return run.failedStep === 'rewrite' ? 2 : 0
}

export function draw(input: DrawInput) {
  const { kit, cols, run, view, history, isAuto, act } = input
  const { Box, Text, Button, Input } = kit
  const rule = (n: number) => '─'.repeat(Math.max(0, n))

  // --- Pieces ---------------------------------------------------------

  const title = () => {
    const name = 'PROMPT UPGRADE'
    const flag = isAuto ? 'AUTO ON' : 'AUTO OFF'

    return (
      <Box flexDirection="column" width={cols}>
        <Box width={cols} justifyContent="space-between">
          <Text bold color={COLOR.text}>
            {name}
          </Text>
          <Text color={isAuto ? COLOR.green : COLOR.muted}>{flag}</Text>
        </Box>
        <Text wrap="truncate-end">
          <Text color={COLOR.gold}>{'━'.repeat(name.length)}</Text>
          <Text color={COLOR.hair}>{rule(cols - name.length)}</Text>
        </Text>
      </Box>
    )
  }

  const heading = (label: string, width: number = cols) => (
    <Text wrap="truncate-end">
      <Text color={COLOR.muted}>{label}</Text>
      <Text color={COLOR.hair}>{' ' + rule(width - label.length - 1)}</Text>
    </Text>
  )

  const chip = (
    key: string,
    label: string,
    kind: 'primary' | 'slate' | 'selected' | 'quiet',
    onPress: (surface: RenderSurface) => void,
  ) => (
    <Button key={key} plain onPress={press => onPress(press.surface)}>
      {kind === 'quiet' ? (
        <Text color={COLOR.muted}>{` ${label} `}</Text>
      ) : kind === 'slate' ? (
        <Text backgroundColor={COLOR.hair} color={COLOR.text}>{` ${label} `}</Text>
      ) : (
        <Text backgroundColor={COLOR.gold} color={COLOR.ink} bold>{` ${label} `}</Text>
      )}
    </Button>
  )

  const tracker = (run: Run) => {
    const current = currentStep(run)
    const isWide = cols >= 58
    const parts: JSX.Element[] = []

    STEPS.forEach((name, index) => {
      const isDone = index < current
      const isNow = index === current
      const mark = isDone ? '✓' : String(index + 1)
      const label = isWide || isNow ? `${mark} ${name}` : mark

      if (index > 0) {
        parts.push(
          <Text key={`gap-${index}`} color={COLOR.hair}>
            {isWide ? ' ── ' : ' ─ '}
          </Text>,
        )
      }

      parts.push(
        <Text
          key={`step-${index}`}
          bold={isNow}
          color={isDone ? COLOR.green : isNow ? COLOR.gold : COLOR.muted}
        >
          {label}
        </Text>,
      )
    })

    return (
      <Box width={cols} flexWrap="nowrap">
        {parts}
      </Box>
    )
  }

  const card = (label: string, body: string, border: string, width: number) => (
    <Box flexDirection="column" width={width}>
      {heading(label, width)}
      <Box
        borderStyle="round"
        borderColor={border}
        paddingX={1}
        width={width}
        flexDirection="column"
      >
        <Text color={COLOR.text}>{body}</Text>
      </Box>
    </Box>
  )

  const tile = (value: number, label: string, color: string) => {
    const rows = bigNumber(value)
    const width = Math.max(bigWidth(value), label.length) + 4

    return (
      <Box
        key={label}
        borderStyle="round"
        borderColor={COLOR.hair}
        paddingX={1}
        width={width}
        flexDirection="column"
      >
        {rows.map((row, index) => (
          <Text key={`${label}-${index}`} bold color={color}>
            {row}
          </Text>
        ))}
        <Text color={COLOR.muted}>{label}</Text>
      </Box>
    )
  }

  const numbers = (before: number, after: number, added: number) => {
    const widths = [
      Math.max(bigWidth(before), 12) + 4,
      Math.max(bigWidth(after), 11) + 4,
      Math.max(bigWidth(added), 13) + 4,
    ]
    const total = widths[0]! + widths[1]! + widths[2]! + 2

    if (total > cols) {
      return (
        <Text wrap="truncate-end" color={COLOR.text}>
          {fit(`${before} words before  →  ${after} words after  ·  ${added} details added`, cols)}
        </Text>
      )
    }

    return (
      <Box gap={1}>
        {tile(before, 'WORDS BEFORE', COLOR.text)}
        {tile(after, 'WORDS AFTER', COLOR.gold)}
        {tile(added, 'DETAILS ADDED', COLOR.green)}
      </Box>
    )
  }

  const frame = (...children: (JSX.Element | null)[]) => (
    <Box flexDirection="column" width={cols} backgroundColor={COLOR.ink} gap={1}>
      {children}
    </Box>
  )

  // --- History --------------------------------------------------------

  if (view === 'history') {
    return frame(
      title(),
      <Box flexDirection="column" width={cols}>
        {heading(`LAST ${history.length} UPGRADES`)}
        {history.length === 0 ? (
          <Text color={COLOR.muted}>No upgrades yet. Try /better followed by a rough prompt.</Text>
        ) : (
          history.map((item, index) => (
            <Button key={`history-${item.id}`} plain onPress={() => act.openHistoryItem(item.id)}>
              <Text color={COLOR.muted}>{String(index + 1).padStart(2, ' ')} </Text>
              <Text color={COLOR.text}>{fit(item.original, Math.max(8, cols - 30))}</Text>
              <Text color={COLOR.muted}>
                {'  '}
                {item.wordsBefore}
                {'→'}
                {item.wordsAfter} {formatWhen(item.at)}
              </Text>
            </Button>
          ))
        )}
      </Box>,
      <Box width={cols}>{chip('close-history', 'Close', 'quiet', act.closeHistory)}</Box>,
    )
  }

  if (run === null) {
    return frame(title(), <Text color={COLOR.muted}>Nothing to show. Run /better to upgrade a prompt.</Text>)
  }

  // --- Compose --------------------------------------------------------

  if (run.phase === 'compose') {
    return frame(
      title(),
      tracker(run),
      <Box flexDirection="column" width={cols}>
        {heading('YOUR PROMPT')}
        <Input
          key="compose"
          label="Rough prompt"
          placeholder="Type what you want, roughly"
          submitLabel="upgrade"
          autoFocus
          onSubmit={value => act.submitCompose(value)}
        />
      </Box>,
      <Box width={cols}>{chip('cancel', 'Cancel', 'quiet', act.cancel)}</Box>,
    )
  }

  // --- Reading and rewriting ------------------------------------------

  if (run.phase === 'reading' || run.phase === 'rewrite') {
    const line =
      run.phase === 'reading'
        ? 'Reading your prompt and deciding what to ask.'
        : 'Writing the upgrade from your answers.'

    return frame(
      title(),
      tracker(run),
      card('YOUR PROMPT', run.original, COLOR.hair, cols),
      <Text color={COLOR.muted}>{line}</Text>,
      <Box width={cols}>{chip('cancel', 'Cancel', 'quiet', act.cancel)}</Box>,
    )
  }

  // --- Questions ------------------------------------------------------

  if (run.phase === 'questions') {
    const answered = run.questions.filter(q => {
      const one = run.answers[q.id]

      return one !== undefined && one.kind !== 'skip'
    }).length
    const skipped = run.questions.filter(q => run.answers[q.id]?.kind === 'skip').length

    return frame(
      title(),
      tracker(run),
      <Box flexDirection="column" width={cols} gap={1}>
        {heading('A FEW QUESTIONS')}
        {run.questions.map((question, index) => {
          const given = run.answers[question.id]
          const isDone = given !== undefined && given.kind !== 'skip'
          const isSkipped = given !== undefined && given.kind === 'skip'

          return (
            <Box key={question.id} width={cols}>
              <Box width={5}>
                {isDone ? (
                  <Text backgroundColor={COLOR.green} color={COLOR.ink} bold>{' ✓ '}</Text>
                ) : isSkipped ? (
                  <Text backgroundColor={COLOR.hair} color={COLOR.muted}>{' – '}</Text>
                ) : (
                  <Text backgroundColor={COLOR.gold} color={COLOR.ink} bold>{` ${index + 1} `}</Text>
                )}
              </Box>
              <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                <Text color={COLOR.text} bold>
                  {question.text}
                </Text>
                <Box flexWrap="wrap" columnGap={1}>
                  {question.options.map(option =>
                    chip(
                      `${question.id}-${option}`,
                      option,
                      given !== undefined && given.kind === 'option' && given.text === option
                        ? 'selected'
                        : 'slate',
                      () => act.pickOption(question.id, option),
                    ),
                  )}
                  {chip(
                    `${question.id}-other`,
                    given !== undefined && given.kind === 'other' ? `Other: ${fit(given.text, 24)}` : 'Other (type it)',
                    given !== undefined && given.kind === 'other' ? 'selected' : 'slate',
                    () => act.openOther(question.id),
                  )}
                  {chip(`${question.id}-skip`, 'Skip', 'quiet', () => act.skipQuestion(question.id))}
                </Box>
                {run.otherFor === question.id ? (
                  <Input
                    key={`other-${question.id}`}
                    label="Your answer"
                    placeholder="Type it, then Enter"
                    value={run.otherDraft}
                    submitLabel="use it"
                    autoFocus
                    onInput={value => act.typeOther(value)}
                    onSubmit={value => act.submitOther(question.id, value)}
                  />
                ) : null}
              </Box>
            </Box>
          )
        })}
      </Box>,
      <Box width={cols} gap={2}>
        <Text color={COLOR.muted}>
          {answered} of {run.questions.length} answered
          {skipped > 0 ? `, ${skipped} skipped` : ''}
        </Text>
      </Box>,
      <Box width={cols} gap={1}>
        {chip('skip-rest', 'Skip the rest, upgrade now', 'primary', act.skipRest)}
        {chip('cancel', 'Cancel', 'quiet', act.cancel)}
      </Box>,
    )
  }

  // --- Error ----------------------------------------------------------

  if (run.phase === 'error') {
    return frame(
      title(),
      tracker(run),
      <Box flexDirection="column" width={cols}>
        {heading('THAT DID NOT GO THROUGH')}
        <Box borderStyle="round" borderColor={COLOR.amber} paddingX={1} width={cols} flexDirection="column">
          <Text color={COLOR.amber} bold>
            Your prompt is safe. Nothing was sent.
          </Text>
          <Text color={COLOR.text}>{run.errorText === '' ? 'The upgrade could not be finished.' : run.errorText}</Text>
        </Box>
      </Box>,
      card('YOUR PROMPT', run.original, COLOR.hair, cols),
      <Box width={cols} gap={1}>
        {chip('retry', 'Try again', 'primary', act.retry)}
        {chip('send-original', 'Send my original', 'slate', act.sendOriginal)}
        {chip('cancel', 'Cancel', 'quiet', act.cancel)}
      </Box>,
    )
  }

  // --- Review ---------------------------------------------------------

  const before = countWords(run.original)
  const after = countWords(run.upgraded)
  const isSideBySide = cols >= 72
  const left = Math.floor((cols - 1) / 2)
  const right = cols - 1 - left

  return frame(
    title(),
    tracker(run),
    numbers(before, after, run.added.length),
    <Box flexDirection="column" width={cols}>
      <Box width={cols} gap={1}>
        {chip('run', 'Run it', 'primary', act.runIt)}
        {chip('edit', run.isEditing ? 'Done editing' : 'Edit', 'slate', act.toggleEdit)}
        {chip('copy', 'Copy', 'slate', surface => act.copy(surface))}
        {chip('cancel', 'Cancel', 'quiet', act.cancel)}
      </Box>
      {run.note === '' ? null : (
        <Text color={run.isNoteWarning ? COLOR.amber : COLOR.green}>{run.note}</Text>
      )}
    </Box>,
    run.isEditing ? (
      <Box flexDirection="column" width={cols}>
        {heading('EDIT THE UPGRADE')}
        <Input
          key="edit"
          label="Upgrade"
          value={run.upgraded}
          submitLabel="run it"
          autoFocus
          onInput={value => act.typeUpgrade(value)}
          onSubmit={value => act.runEdited(value)}
        />
      </Box>
    ) : null,
    <Box flexDirection="column" width={cols}>
      {heading('WHAT I ADDED')}
      {run.added.length === 0 ? (
        <Text color={COLOR.muted}>Nothing new was needed. The wording was tightened.</Text>
      ) : (
        run.added.map((item, index) => (
          <Text key={`added-${index}`} wrap="truncate-end">
            <Text color={COLOR.green}>+ </Text>
            <Text color={COLOR.text}>{fit(item, cols - 2)}</Text>
          </Text>
        ))
      )}
    </Box>,
    isSideBySide ? (
      <Box width={cols} gap={1}>
        {card('YOUR PROMPT', run.original, COLOR.hair, left)}
        {card('THE UPGRADE', run.upgraded, COLOR.gold, right)}
      </Box>
    ) : (
      <Box flexDirection="column" width={cols} gap={1}>
        {card('YOUR PROMPT', run.original, COLOR.hair, cols)}
        {card('THE UPGRADE', run.upgraded, COLOR.gold, cols)}
      </Box>
    ),
  )
}
