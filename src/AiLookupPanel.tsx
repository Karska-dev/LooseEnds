import type { CSSProperties } from 'react'
import type { AiAllowance, AiStop } from './aiResolve.ts'
import type { Messages } from './i18n/index.ts'
import { useLanguage } from './language.ts'
import { brief } from './lookupWords.ts'
import { Rich } from './Rich.tsx'
import type { SeriesState } from './state'
import { setTurnstileSlot } from './turnstile'

/**
 * - checking: the tab has just been opened and is asking what is already known
 * - before:   some series have never been looked up; the button offers them
 * - during:   looking them up, one at a time
 * - after:    every series has an answer
 * - stopped:  the lookup could not go on; `stop` says why
 *
 * Pattern: a finite state machine. The panel is in exactly one named phase
 * at a time and everything on it follows from that phase. The alternative,
 * a handful of booleans (loading, failed, done), can contradict each other.
 */
export type AiPhase = 'checking' | 'before' | 'during' | 'after' | 'stopped'

/**
 * When the shared allowance starts again, in the reader's own clock. It is
 * counted per UTC day, which nobody thinks in.
 */
function nextReset(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
}

function Allowance({ allowance, note }: { allowance: AiAllowance | null; note?: string | null }) {
  const { t } = useLanguage()
  if (!allowance) return null
  const share = allowance.cap > 0 ? Math.min(1, allowance.left / allowance.cap) : 0
  return (
    <div className="allowance">
      <span className="allowance-bar" aria-hidden="true">
        <i style={{ width: `${share * 100}%` }} />
      </span>
      <span>
        <Rich text={t.ai.allowance(allowance.left, allowance.cap)} tags={{ b: (n) => <b>{n}</b> }} />
      </span>
      {note && <small>{note}</small>}
    </div>
  )
}

/** One line per series that came back, as in the Hardcover panel, plus the misses. */
function heardLine(state: SeriesState, t: Messages): { kind: string; label: string; text: string } {
  const miss = state.ai?.miss
  if (miss === 'not_confirmed') return { kind: 'wait', label: t.brief.notConfirmed, text: t.brief.pagesDisagreed }
  if (miss) return { kind: 'wait', label: t.brief.notFound, text: t.brief.nothingToday }
  return brief(state, t)
}

/**
 * The AI lookup told as a sentence, in the same frame as the Hardcover one
 * (LookupPanel) so the page does not change shape between tabs. What differs
 * is everything it has to be honest about: that it is an experiment, where
 * the names go, that there is a small allowance everyone shares, and that
 * what is already known is shown without being asked for.
 *
 * Pattern: a presentational component. It is given everything as props and
 * reports a press through onLookUp; it fetches nothing and keeps no data.
 * The lookup itself lives in App.tsx and the sentences in the catalogue
 * (`ai` in src/i18n), so this file only decides which sentence applies.
 */
export function AiLookupPanel({
  phase,
  total,
  foundCount,
  pendingCount,
  currentName,
  heard,
  knownNames,
  ready,
  missedNames,
  stop,
  allowance,
  onLookUp,
}: {
  phase: AiPhase
  /** Series the lookup covers. */
  total: number
  /** How many have a book list. */
  foundCount: number
  /** How many have never been answered, or failed and can be asked again. */
  pendingCount: number
  /** The series being looked up right now. */
  currentName: string | null
  /** The latest answers, oldest first; at most three are shown. */
  heard: SeriesState[]
  /** Found before the button was pressed: looked up on an earlier visit, or by someone else. */
  knownNames: string[]
  /** Series with a next book out. */
  ready: number
  /** Looked up, and no list came of it. */
  missedNames: string[]
  stop: AiStop | null
  allowance: AiAllowance | null
  onLookUp: () => void
}) {
  const { t } = useLanguage()
  const words = t.ai
  const answered = total - pendingCount

  // An allowance already at nothing is the same stop, known before pressing.
  const spent = allowance !== null && allowance.left <= 0 && pendingCount > 0
  const shown: AiPhase = phase === 'before' && spent ? 'stopped' : phase
  const why: AiStop | null = shown === 'stopped' ? (stop ?? 'budget') : null

  const knownLine = knownNames.length > 0 && pendingCount > 0 ? words.known(knownNames) : null

  let title: string
  let body: string | null = null
  let fine: string | null = null
  let stamp: string | null = null
  let canPress = false
  let buttonLabel = words.go(total, pendingCount)

  if (shown === 'checking') {
    title = words.checkingTitle(total)
    body = words.checkingBody
  } else if (shown === 'before') {
    title = words.beforeTitle(total, pendingCount)
    body = words.beforeBody
    fine = words.fine
    canPress = true
  } else if (shown === 'during') {
    title = words.duringTitle
    body = words.duringBody(answered, total)
  } else if (shown === 'after') {
    title = words.afterTitle(foundCount, total)
    body = words.afterBody(ready, missedNames)
    if (foundCount > 0) stamp = words.stamp
  } else if (why === 'budget') {
    title = words.budgetTitle
    body = words.budgetBody({
      cap: allowance ? allowance.cap : null,
      when: t.clock(nextReset()),
      answered,
      pending: pendingCount,
      total,
    })
  } else if (why === 'month') {
    title = words.monthTitle
    body = words.monthBody(answered, pendingCount)
  } else if (why === 'unset') {
    title = words.unsetTitle
    body = words.unsetBody
  } else if (why === 'check') {
    title = words.checkTitle
    body = words.checkBody
    canPress = true
    buttonLabel = words.tryAgain
  } else if (why === 'busy') {
    title = words.busyTitle
    body = words.busyBody(answered, total)
    canPress = true
  } else {
    title = words.unreachableTitle
    body = words.unreachableBody(answered, total)
    canPress = true
    buttonLabel = words.tryAgainNow
  }

  const shownHeard = heard.slice(-3)
  const spoken = shown === 'during' ? words.spoken(answered, total) : title
  // The same three looks as the Hardcover panel: indigo while working, green
  // when done, the accent when it could not go on.
  const dataPhase = shown === 'stopped' ? 'failed' : shown === 'checking' ? 'before' : shown

  return (
    <div className="lookup lookup-ai" data-phase={dataPhase}>
      <div
        className="lookup-meter"
        style={{ '--p': total > 0 ? answered / total : 0 } as CSSProperties}
        aria-hidden="true"
      >
        <span className="lookup-orbit" />
        <span className="lookup-meter-n">
          {answered}/{total}
        </span>
      </div>

      <div className="lookup-text">
        <p className="sr-only" aria-live="polite">
          {spoken}
        </p>

        <h3 className="lookup-title" aria-hidden="true">
          {title}
          {shown === 'during' && currentName && (
            <>
              {' '}
              <em>{currentName}</em>
            </>
          )}
          {shown === 'during' && (
            <>
              <span className="lookup-dots">
                <i />
                <i />
                <i />
              </span>
              <span className="lookup-cursor" />
            </>
          )}
        </h3>

        {body && <p className="lookup-body">{body}</p>}
        {fine && <p className="ai-fine">{fine}</p>}
        {stamp && <p className="ai-stamp">{stamp}</p>}

        {shown === 'during' && shownHeard.length > 0 && (
          <ul className="lookup-heard">
            {shownHeard.map((state) => {
              const line = heardLine(state, t)
              return (
                <li key={state.key}>
                  <span className={`badge badge-${line.kind}`}>{line.label}</span>
                  <span>
                    <b>{state.name}</b> &mdash; {line.text}
                  </span>
                </li>
              )
            })}
          </ul>
        )}

        {shown !== 'after' && shown !== 'checking' && (
          <Allowance allowance={allowance} note={shown === 'before' ? knownLine : null} />
        )}

        {/* Where Cloudflare Turnstile may ask for a click; see src/turnstile.ts. */}
        <div className="turnstile-slot" ref={setTurnstileSlot} />

        {shown !== 'during' && shown !== 'after' && why !== 'unset' && (
          <div className="lookup-actions">
            <button
              type="button"
              className={`lookup-go${shown === 'stopped' && canPress ? ' lookup-retry' : ''}`}
              disabled={!canPress}
              onClick={onLookUp}
            >
              {buttonLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
