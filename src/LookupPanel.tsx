import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { useLanguage } from './language.ts'
import { brief } from './lookupWords.ts'
import type { SeriesState } from './state'
import { setTurnstileSlot } from './turnstile'

export type LookupPhase = 'before' | 'during' | 'after' | 'failed'
export type FailureKind = 'busy' | 'unset' | 'unreachable' | 'check' | 'budget'

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
 *
 * The sentences themselves are in the catalogue (`lookup` in src/i18n);
 * this component decides which one applies and where it goes.
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
  const { t } = useLanguage()
  const words = t.lookup
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
  // The reset happens during render, when the panel turns busy, rather than
  // in the effect: setting state from an effect body costs an extra render.
  const busy = phase === 'failed' && failure === 'busy'
  const [secs, setSecs] = useState(60)
  const [wasBusy, setWasBusy] = useState(busy)
  if (busy !== wasBusy) {
    setWasBusy(busy)
    if (busy) setSecs(60)
  }
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => setSecs((value) => (value > 0 ? value - 1 : 0)), 1000)
    return () => clearInterval(timer)
  }, [busy])

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
    title = words.beforeTitle(total)
    body = words.beforeBody
  } else if (phase === 'during') {
    title = words.asking
  } else if (phase === 'after') {
    title = words.afterTitle(summary.ready)
    body = words.afterBody(summary)
  } else if (failure === 'unset') {
    title = words.unsetTitle
    body = words.unsetBody
  } else if (failure === 'budget') {
    title = words.budgetTitle
    body = words.budgetBody(heardCount, total)
  } else if (failure === 'check') {
    title = words.checkTitle
    body = words.checkBody
  } else {
    title = failure === 'busy' ? words.busyTitle : words.unreachableTitle
    body = words.failedBody(heardCount, total, failedNames, failure === 'busy' ? secs : null)
  }

  const spoken = phase === 'during' ? words.spoken(heardCount, total) : title

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

        {phase === 'during' && <p className="lookup-body">{words.heardSoFar(heardCount, total)}</p>}
        {body && <p className="lookup-body">{body}</p>}

        {phase === 'during' && shown.length > 0 && (
          <ul className="lookup-heard">
            {shown.map((state) => {
              const line = brief(state, t)
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
              {words.go(total)}
            </button>
          </div>
        )}

        {/* Where Cloudflare Turnstile may ask for a click. Empty and
            invisible for most people; see src/turnstile.ts. */}
        <div className="turnstile-slot" ref={setTurnstileSlot} />

        {phase === 'failed' && (
          <div className="lookup-actions">
            <button type="button" className="lookup-go lookup-retry" onClick={onLookUp}>
              {words.retry}
            </button>
            {heardCount > 0 && (
              <button type="button" className="ghost" onClick={onShowResults}>
                {words.showWhatWeHave(heardCount)}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
