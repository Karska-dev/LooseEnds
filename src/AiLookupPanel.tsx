import type { CSSProperties } from 'react'
import type { AiAllowance, AiStop } from './aiResolve.ts'
import { brief, listNames, word } from './LookupPanel.tsx'
import type { SeriesState } from './state'
import { setTurnstileSlot } from './turnstile'

/**
 * - checking: the tab has just been opened and is asking what is already known
 * - before:   some series have never been looked up; the button offers them
 * - during:   looking them up, one at a time
 * - after:    every series has an answer
 * - stopped:  the lookup could not go on; `stop` says why
 */
export type AiPhase = 'checking' | 'before' | 'during' | 'after' | 'stopped'

/**
 * When the shared allowance starts again, in the reader's own clock. It is
 * counted per UTC day, which nobody thinks in.
 */
function resetTime(now = new Date()): string {
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  return reset.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

function Allowance({ allowance, note }: { allowance: AiAllowance | null; note?: string | null }) {
  if (!allowance) return null
  const share = allowance.cap > 0 ? Math.min(1, allowance.left / allowance.cap) : 0
  return (
    <div className="allowance">
      <span className="allowance-bar" aria-hidden="true">
        <i style={{ width: `${share * 100}%` }} />
      </span>
      <span>
        <b>{allowance.left}</b> of {allowance.cap} shared AI lookups left today
      </span>
      {note && <small>{note}</small>}
    </div>
  )
}

/** One line per series that came back, as in the Hardcover panel, plus the misses. */
function heardLine(state: SeriesState): { kind: string; label: string; text: string } {
  const miss = state.ai?.miss
  if (miss === 'not_confirmed') return { kind: 'wait', label: 'Not confirmed', text: 'the pages didn’t agree' }
  if (miss) return { kind: 'wait', label: 'Not found', text: 'nothing about it today' }
  return brief(state)
}

/**
 * The AI lookup told as a sentence, in the same frame as the Hardcover one
 * (LookupPanel) so the page does not change shape between tabs. What differs
 * is everything it has to be honest about: that it is an experiment, where
 * the names go, that there is a small allowance everyone shares, and that
 * what is already known is shown without being asked for.
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
  const answered = total - pendingCount
  const others = pendingCount === total ? '' : 'other '
  const lookUpLabel =
    pendingCount === total
      ? `Look up ${total} series with AI`
      : `Look up ${pendingCount} more with AI`

  // An allowance already at nothing is the same stop, known before pressing.
  const spent = allowance !== null && allowance.left <= 0 && pendingCount > 0
  const shown: AiPhase = phase === 'before' && spent ? 'stopped' : phase
  const why: AiStop | null = shown === 'stopped' ? (stop ?? 'budget') : null

  const knownLine =
    knownNames.length > 0 && pendingCount > 0
      ? `${listNames(knownNames)} ${plural(knownNames.length, 'was', 'were')} looked up before, so ${plural(knownNames.length, 'it’s', 'they’re')} already below.`
      : null

  let title: string
  let body: string | null = null
  let fine: string | null = null
  let stamp: string | null = null
  let canPress = false
  let buttonLabel = lookUpLabel

  if (shown === 'checking') {
    title = `Look up your ${total} series with AI`
    body = 'Checking which of them have been looked up before…'
  } else if (shown === 'before') {
    title = `Look up your ${others}${pendingCount} series with AI`
    body =
      'An experiment. For each series, AI searches the web, reads the author’s and publisher’s pages it finds, and lists the books. It can get things wrong, so every book links to the page it came from.'
    fine =
      'Series names and authors are sent to a search service (Tavily) and to Cloudflare’s AI. Your books and ratings stay in this browser. Results are separate from Hardcover’s and never replace them.'
    canPress = true
  } else if (shown === 'during') {
    title = 'Searching the web for'
    body = `Heard back about ${answered} of ${total} so far. Each one takes a little while: a search, then AI reads what it found.`
  } else if (shown === 'after') {
    title =
      foundCount === 0
        ? `AI couldn’t find ${total === 1 ? 'your series' : 'any of your series'}`
        : foundCount === total
          ? total === 1
            ? 'AI found your series'
            : `AI found all ${word(total)} of your series`
          : `AI found ${word(foundCount)} of your ${word(total)} series`
    const parts: string[] = []
    if (ready > 0) parts.push(`${word(ready, true)} ${plural(ready, 'has', 'have')} a next book waiting.`)
    if (missedNames.length > 0) {
      parts.push(`${listNames(missedNames)} couldn’t be confirmed from the pages found.`)
    }
    body = parts.length > 0 ? parts.join(' ') : null
    if (foundCount > 0) stamp = 'Found by AI. It can be wrong: check the linked page before you buy.'
  } else if (why === 'budget') {
    title = 'Today’s AI lookups are used up'
    const when = resetTime()
    body =
      `Everyone using Loose Ends shares ${allowance ? allowance.cap : 'a small number of'} new AI lookups a day. They start again at ${when} your time. ` +
      (answered > 0
        ? `${word(answered, true)} of your series ${plural(answered, 'is', 'are')} already below. The other ${word(pendingCount)} can be looked up after ${when}.`
        : `Your ${word(total)} series can be looked up after ${when}.`)
  } else if (why === 'month') {
    title = 'This month’s AI lookups are used up'
    body =
      'The search this experiment runs on gives a fixed number of free searches a month, and they are gone. ' +
      (answered > 0
        ? `What was looked up before is below; the other ${word(pendingCount)} can be looked up next month.`
        : 'Your series can be looked up next month.')
  } else if (why === 'unset') {
    title = 'AI lookup isn’t set up here'
    body = 'This server isn’t configured for it yet, so nothing new can be looked up.'
  } else if (why === 'check') {
    title = 'Couldn’t confirm you’re a person'
    body =
      'Cloudflare’s quick check didn’t go through, so nothing was looked up. Try again — if a box appears, tick it.'
    canPress = true
    buttonLabel = 'Try again'
  } else if (why === 'busy') {
    title = 'Too many lookups at once'
    body = `We heard back about ${answered} of your ${total} series. Give it a minute, then carry on.`
    canPress = true
  } else {
    title = 'Couldn’t reach the AI lookup'
    body =
      (answered > 0 ? `We heard back about ${answered} of your ${total} series. ` : `None of your ${total} series came back. `) +
      'Try again — it is usually temporary.'
    canPress = true
    buttonLabel = 'Try again now'
  }

  const shownHeard = heard.slice(-3)
  const spoken =
    shown === 'during'
      ? `Looking up series with AI: ${answered} of ${total} done.`
      : title
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
              const line = heardLine(state)
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
