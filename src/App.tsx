import { useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import { parseGoodreadsCsv } from './goodreads'
import type { ParseResult } from './goodreads'
import { groupIntoSeries } from './series'
import type { SeriesSummary } from './series'
import { resolveAllSeries } from './resolve'
import type { SeriesResult } from './resolve'
import { buildSeriesState, sortSeriesStates } from './state'
import type { SeriesState } from './state'

export default function App() {
  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const [summary, setSummary] = useState<SeriesSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    setError(null)
    try {
      const result = parseGoodreadsCsv(await file.text())
      if (result.books.length === 0) {
        setError('That file has no book rows. Is it the Goodreads library export?')
        setParsed(null)
        setSummary(null)
        return
      }
      setParsed(result)
      setSummary(groupIntoSeries(result.books))
    } catch {
      setError('That file could not be read. Try exporting it again from Goodreads.')
      setParsed(null)
      setSummary(null)
    }
  }

  return (
    <main className="page">
      <header className="masthead">
        <h1>Loose Ends</h1>
        <p className="tagline">
          You&rsquo;ve read four. There are seven. Here&rsquo;s book five.
        </p>
      </header>

      <section className="intake">
        <h2>Your Goodreads export</h2>
        <input type="file" id="export-file" accept=".csv" onChange={handleFile} />
        <p className="note">
          Read here in your browser. Nothing is uploaded and nothing is stored.
        </p>
        {error && <p className="error">{error}</p>}
        {parsed && (
          <p className="note">
            {parsed.counts.read} read &middot; {parsed.counts.reading} reading &middot;{' '}
            {parsed.counts.to_read} to read &middot; {parsed.counts.dnf} did not finish
          </p>
        )}
      </section>

      {summary && <SeriesBoard summary={summary} />}

      <footer className="colophon">
        Series data from Hardcover. Your library never leaves this browser.
      </footer>
    </main>
  )
}

function SeriesBoard({ summary }: { summary: SeriesSummary }) {
  const started = useMemo(
    () => summary.groups.filter((group) => group.readCount > 0),
    [summary],
  )
  const [resolved, setResolved] = useState<Map<string, SeriesResult>>(new Map())
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [showDismissed, setShowDismissed] = useState(false)
  const [showComplete, setShowComplete] = useState(false)

  async function lookUp() {
    setProgress({ done: 0, total: started.length })
    const results = await resolveAllSeries(
      started.map((group) => ({ key: group.key, name: group.name, author: group.author })),
      (done, total, soFar) => {
        setResolved(soFar)
        setProgress({ done, total })
      },
    )
    setResolved(results)
    setProgress(null)
    // A DNF is a strong hint the reader is done with the series.
    setDismissed(
      new Set(started.filter((group) => group.hasDnf).map((group) => group.key)),
    )
  }

  const states = useMemo(
    () => sortSeriesStates(started.map((g) => buildSeriesState(g, resolved.get(g.key)))),
    [started, resolved],
  )

  const visible = states.filter((state) => {
    if (dismissed.has(state.key)) return showDismissed
    if (state.status === 'complete') return showComplete
    return true
  })
  const counts = {
    next_available: states.filter((s) => s.status === 'next_available' && !dismissed.has(s.key)).length,
    waiting: states.filter((s) => s.status === 'waiting' && !dismissed.has(s.key)).length,
    complete: states.filter((s) => s.status === 'complete').length,
    reading: states.filter((s) => s.status === 'reading' && !dismissed.has(s.key)).length,
  }

  function toggle(key: string) {
    setDismissed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <section className="board">
      <h2>Series</h2>

      <div className="actions">
        <button type="button" onClick={lookUp} disabled={progress !== null}>
          {progress
            ? `Looking up… ${progress.done} of ${progress.total}`
            : `Look up ${started.length} series`}
        </button>
        {progress && (
          <div
            className="meter"
            role="progressbar"
            aria-valuenow={progress.done}
            aria-valuemin={0}
            aria-valuemax={progress.total}
          >
            <span style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
        )}
      </div>

      {resolved.size > 0 && (
        <dl className="tiles">
          <div className="tile">
            <dt>Ready to read</dt>
            <dd>{counts.next_available}</dd>
          </div>
          <div className="tile">
            <dt>Reading now</dt>
            <dd>{counts.reading}</dd>
          </div>
          <div className="tile">
            <dt>Waiting on author</dt>
            <dd>{counts.waiting}</dd>
          </div>
          <div className="tile">
            <dt>Finished</dt>
            <dd>{counts.complete}</dd>
          </div>
          <div className="tile">
            <dt>Set aside</dt>
            <dd>{dismissed.size}</dd>
          </div>
        </dl>
      )}

      {(dismissed.size > 0 || counts.complete > 0) && (
        <div className="toggles">
          {counts.complete > 0 && (
            <label className="toggle">
              <input
                type="checkbox"
                id="show-complete"
                checked={showComplete}
                onChange={(event) => setShowComplete(event.target.checked)}
              />
              Show {counts.complete} finished
            </label>
          )}
          {dismissed.size > 0 && (
            <label className="toggle">
              <input
                type="checkbox"
                id="show-dismissed"
                checked={showDismissed}
                onChange={(event) => setShowDismissed(event.target.checked)}
              />
              Show {dismissed.size} set aside
            </label>
          )}
        </div>
      )}

      <ul className="series-list">
        {visible.map((state) => (
          <SeriesRow
            key={state.key}
            state={state}
            dismissed={dismissed.has(state.key)}
            onToggle={() => toggle(state.key)}
          />
        ))}
      </ul>
    </section>
  )
}

function SeriesRow({
  state,
  dismissed,
  onToggle,
}: {
  state: SeriesState
  dismissed: boolean
  onToggle: () => void
}) {
  return (
    <li className={`series-row${dismissed ? ' is-dismissed' : ''}`}>
      <div className="series-head">
        <div className="series-id">
          <h3>{state.name}</h3>
          <p className="byline">{state.author}</p>
        </div>
        <button type="button" className="ghost" onClick={onToggle}>
          {dismissed ? 'Bring back' : 'Set aside'}
        </button>
      </div>

      <p className="progress-line">
        <b>{state.readCount}</b>
        {state.totalBooks !== null ? ` of ${state.totalBooks} read` : ' read'}
      </p>

      <Verdict state={state} />
    </li>
  )
}

function Verdict({ state }: { state: SeriesState }) {
  if (state.status === 'unknown') {
    return <p className="verdict muted">Not looked up yet</p>
  }
  if (state.status === 'reading') {
    return <p className="verdict muted">You&rsquo;re reading it now</p>
  }
  if (state.status === 'complete') {
    return <p className="verdict muted">You&rsquo;ve finished it</p>
  }
  if (state.status === 'partial') {
    return (
      <p className="verdict muted">
        Nothing left to read here, but the volume list looks incomplete
      </p>
    )
  }

  const next = state.next
  if (!next) return null

  const title = (
    <span className="next-title">
      #{next.position} {next.title}
    </span>
  )

  if (next.publication === 'published') {
    return (
      <p className="verdict">
        <span className="badge badge-go">Next</span>
        {title}
        {next.onYourList && <span className="muted">&middot; already on your list</span>}
      </p>
    )
  }

  if (next.publication === 'announced') {
    return (
      <p className="verdict">
        <span className="badge badge-soon">Due {next.releaseDate}</span>
        {title}
      </p>
    )
  }

  return (
    <p className="verdict">
      <span className="badge badge-wait">No date yet</span>
      {title}
    </p>
  )
}
