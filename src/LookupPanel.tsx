import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { SeriesState } from './state'

export type LookupPhase = 'before' | 'during' | 'after' | 'failed'
export type FailureKind = 'busy' | 'unset' | 'unreachable'

type BadgeKind = 'go' | 'soon' | 'wait' | 'done'

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']

function word(n: number, capital = false): string {
  const text = n < WORDS.length ? WORDS[n] : String(n)
  return capital ? text : text.toLowerCase()
}

/** "A", "A and B", "A, B and C", then "A, B, C and 2 more". */
function listNames(names: string[]): string {
  if (names.length === 0) return ''
  const shown = names.length > 3 ? names.slice(0, 3) : names
  const rest = names.length - shown.length
  const parts = rest > 0 ? [...shown, `${rest} more`] : shown
  if (parts.length === 1) return parts[0]
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

function sentence(parts: string[]): string {
  const joined = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`
}

/** One line per series that came back: the same verdict the row shows, shorter. */
function brief(state: SeriesState): { kind: BadgeKind; label: string; text: string } {
  const next = state.next
  if (state.inProgress) {
    return {
      kind: 'soon',
      label: 'Reading',
      text: state.inProgressPosition !== null ? `you’re on #${state.inProgressPosition}` : 'you’re on it',
    }
  }
  if (state.status === 'next_available' && next) {
    return { kind: 'go', label: 'Next', text: `#${next.position} ${next.title}` }
  }
  if (state.status === 'waiting' && next) {
    return next.publication === 'announced'
      ? { kind: 'wait', label: 'Due', text: `#${next.position} ${next.title}, ${next.releaseDate}` }
      : { kind: 'wait', label: 'Waiting', text: `#${next.position} ${next.title}` }
  }
  if (state.status === 'complete') return { kind: 'done', label: 'Finished', text: 'all read' }
  if (state.status === 'reading') return { kind: 'soon', label: 'Reading', text: 'the last one' }
  return { kind: 'done', label: 'Caught up', text: 'nothing left to read' }
}

export interface LookupSummary {
  ready: number
  reading: string[]
  waiting: string[]
  complete: string[]
}

/**
 * The lookup told as a sentence: what is about to happen, who is being asked
 * about, what came back. Before, during and failed share one minimum height
 * so the page underneath does not jump between them; the finished panel is
 * allowed to be shorter, because nothing follows it.
 */
export function LookupPanel({
  phase,
  total,
  heardCount,
  heard,
  pendingNames,
  summary,
  failedNames,
  failure,
  onLookUp,
  onShowResults,
}: {
  phase: LookupPhase
  /** Series the lookup covers. */
  total: number
  /** How many have come back with an answer. */
  heardCount: number
  /** The latest answers, oldest first; at most three are shown. */
  heard: SeriesState[]
  /** Still waiting on these, for the "Asking about …" line. */
  pendingNames: string[]
  summary: LookupSummary
  failedNames: string[]
  failure: FailureKind
  onLookUp: () => void
  onShowResults: () => void
}) {
  // The batch is in flight as one request, so which series is "current" is
  // not knowable; cycling through the ones still out is honest about that
  // and keeps the line moving.
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (phase !== 'during') return
    const timer = setInterval(() => setTick((value) => value + 1), 1500)
    return () => clearInterval(timer)
  }, [phase])

  // Rate limits are per minute, so a busy failure counts down one minute.
  const [secs, setSecs] = useState(60)
  useEffect(() => {
    if (phase !== 'failed' || failure !== 'busy') return
    setSecs(60)
    const timer = setInterval(() => setSecs((value) => (value > 0 ? value - 1 : 0)), 1000)
    return () => clearInterval(timer)
  }, [phase, failure])

  const current = pendingNames.length > 0 ? pendingNames[tick % pendingNames.length] : null
  const shown = heard.slice(-3)

  let meterValue = 0
  let meterLabel = String(total)
  if (phase === 'during' || phase === 'failed') {
    meterValue = total > 0 ? heardCount / total : 0
    meterLabel = `${heardCount}/${total}`
  } else if (phase === 'after') {
    meterValue = 1
    meterLabel = `${total}/${total}`
  }

  let title: string
  let body: string | null = null
  if (phase === 'before') {
    title = `Ready to look up ${total} series`
    body =
      'We’ll ask Hardcover what comes next in each one. It takes a few seconds, and your library never leaves this browser.'
  } else if (phase === 'during') {
    title = 'Asking about'
  } else if (phase === 'after') {
    title =
      summary.ready > 0
        ? `${word(summary.ready, true)} series ${summary.ready === 1 ? 'has' : 'have'} a next book waiting`
        : 'You’re all caught up'
    const parts: string[] = []
    const { reading, waiting, complete } = summary
    if (reading.length === 1) parts.push(`you’re partway through ${reading[0]}`)
    else if (reading.length > 1) parts.push(`you’re partway through ${word(reading.length)} series`)
    if (waiting.length === 1) parts.push(`${waiting[0]} is waiting on its author`)
    else if (waiting.length > 1) parts.push(`${word(waiting.length)} are waiting on their authors`)
    if (complete.length === 1) parts.push(`you’ve finished ${complete[0]}`)
    else if (complete.length > 1) parts.push(`you’ve finished ${word(complete.length)}`)
    body = parts.length > 0 ? sentence(parts) : null
  } else if (failure === 'unset') {
    title = 'Series lookup isn’t set up here'
    body = 'This server has no Hardcover token configured, so nothing can be looked up yet.'
  } else {
    title = failure === 'busy' ? 'Hardcover is busy right now' : 'Couldn’t reach Hardcover'
    const heardLine =
      heardCount > 0
        ? `We heard back about ${heardCount} of your ${total} series.`
        : `None of your ${total} series came back.`
    const who = heardCount > 0 ? listNames(failedNames) : 'They'
    body =
      failure === 'busy'
        ? secs > 0
          ? `${heardLine} ${who} can try again in ${secs} seconds.`
          : `${heardLine} ${who} can try again now.`
        : `${heardLine} Try again — it is usually temporary.`
  }

  const spoken =
    phase === 'during' ? `Looking up series: ${heardCount} of ${total} done.` : title

  return (
    <div className="lookup" data-phase={phase}>
      <div
        className="lookup-meter"
        style={{ '--p': meterValue } as CSSProperties}
        aria-hidden="true"
      >
        <span className="lookup-orbit" />
        <span className="lookup-meter-n">{meterLabel}</span>
      </div>

      <div className="lookup-text">
        <p className="sr-only" aria-live="polite">
          {spoken}
        </p>

        <h3 className="lookup-title" aria-hidden="true">
          {title}
          {phase === 'during' && current && (
            <>
              {' '}
              <em>{current}</em>
            </>
          )}
          {phase === 'during' && (
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

        {phase === 'during' && (
          <p className="lookup-body">
            Heard back about {heardCount} of {total} so far.
          </p>
        )}
        {body && <p className="lookup-body">{body}</p>}

        {phase === 'during' && shown.length > 0 && (
          <ul className="lookup-heard">
            {shown.map((state) => {
              const line = brief(state)
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

        {phase === 'before' && (
          <div className="lookup-actions">
            <button type="button" className="lookup-go" onClick={onLookUp}>
              Look up {total} series
            </button>
          </div>
        )}

        {phase === 'failed' && (
          <div className="lookup-actions">
            <button type="button" className="lookup-go lookup-retry" onClick={onLookUp}>
              Try again now
            </button>
            {heardCount > 0 && (
              <button type="button" className="ghost" onClick={onShowResults}>
                Show the {heardCount} we have
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
