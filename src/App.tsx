import { useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import { parseGoodreadsCsv } from './goodreads'
import type { Book, ParseResult } from './goodreads'
import { groupIntoSeries } from './series'
import type { SeriesSummary } from './series'
import { resolveAllSeries } from './resolve'
import type { SeriesResult } from './resolve'
import { buildSeriesState, sortSeriesStates } from './state'
import type { SeriesState, VolumeRow } from './state'

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

        <ol className="how">
          <li>
            On Goodreads, open <b>My Books</b>
          </li>
          <li>
            In the left sidebar under Tools, choose <b>Import and export</b>
          </li>
          <li>
            Click <b>Export Library</b>, wait a few seconds, then download the file
          </li>
        </ol>
        <p className="note">
          Desktop browser only &mdash; the Goodreads app has no export. Don&rsquo;t open
          the file in Excel first; it quietly changes ISBNs and dates.
        </p>

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
        {summary && (
          <p className="note">
            {parsed!.books.length - summary.unmatched.length} in a series &middot;{' '}
            {summary.unmatched.length} not in a series
          </p>
        )}
      </section>

      {summary && <SeriesBoard summary={summary} />}

      <footer className="colophon">
        Series data and covers from{' '}
        <a href="https://hardcover.app" target="_blank" rel="noopener noreferrer">
          Hardcover
        </a>
        . Your library never leaves this browser.
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
  const [showStandalone, setShowStandalone] = useState(false)
  const [openKey, setOpenKey] = useState<string | null>(null)

  /**
   * Books whose Goodreads title carried no series. Mostly genuine
   * standalones, plus the occasional series book Goodreads never labelled —
   * which is exactly why they are worth showing rather than dropping.
   */
  const standalone = useMemo(
    () =>
      [...summary.unmatched].sort(
        (a, b) =>
          DISPLAY_RANK[a.shelf] - DISPLAY_RANK[b.shelf] || a.title.localeCompare(b.title),
      ),
    [summary],
  )

  /** Series present in the export but never started: not loose ends, still counted. */
  const notStarted = summary.groups.length - started.length

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
    // A DNF part-way through means the reader walked away — set those aside.
    // A DNF in a series with nothing left to read is just how it ended, and
    // belongs with the finished ones instead.
    setDismissed(
      new Set(
        started
          .filter((group) => {
            if (!group.hasDnf) return false
            return buildSeriesState(group, results.get(group.key)).status !== 'complete'
          })
          .map((group) => group.key),
      ),
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
    failed: [...resolved.values()].filter((entry) => entry.status === 'error').length,
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

      {!progress && counts.failed > 0 && (
        <p className="error" role="status">
          {counts.failed === states.length
            ? failureMessage(firstDetail(resolved))
            : `${counts.failed} series couldn\u2019t be looked up. Try again \u2014 it is usually temporary.`}
        </p>
      )}

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

      {(dismissed.size > 0 || counts.complete > 0 || standalone.length > 0) && (
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
          {standalone.length > 0 && (
            <label className="toggle">
              <input
                type="checkbox"
                id="show-standalone"
                checked={showStandalone}
                onChange={(event) => setShowStandalone(event.target.checked)}
              />
              Show {standalone.length} not in a series
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
            open={openKey === state.key}
            onOpen={() => setOpenKey(openKey === state.key ? null : state.key)}
          />
        ))}
        {showStandalone && standalone.length > 0 && (
          <StandaloneRow
            books={standalone}
            open={openKey === STANDALONE_KEY}
            onOpen={() =>
              setOpenKey(openKey === STANDALONE_KEY ? null : STANDALONE_KEY)
            }
          />
        )}
      </ul>

      {notStarted > 0 && (
        <p className="note">
          {notStarted} series in your export {notStarted === 1 ? 'has' : 'have'} nothing
          read yet, so {notStarted === 1 ? 'it is' : 'they are'} not listed here.
        </p>
      )}
    </section>
  )
}

const STANDALONE_KEY = '\u0000standalone'

/** Read first, then in progress, then abandoned, then the wishlist. */
const DISPLAY_RANK: Record<string, number> = { read: 0, reading: 1, dnf: 2, to_read: 3 }

/**
 * One collapsed row rather than several hundred loose ones: these are not
 * series, and a series list is the wrong place to scatter them.
 */
function StandaloneRow({
  books,
  open,
  onOpen,
}: {
  books: Book[]
  open: boolean
  onOpen: () => void
}) {
  const readCount = books.filter((book) => book.shelf === 'read').length

  return (
    <li className={`series-row is-standalone${open ? ' is-open' : ''}`}>
      <div className="series-head">
        <button
          type="button"
          className="disclose"
          aria-expanded={open}
          aria-controls="standalone-books"
          onClick={onOpen}
        >
          <span className="chevron" aria-hidden="true">
            {open ? '\u2212' : '+'}
          </span>
          <Cover url={null} alt="" size="lg" />
          <span className="series-id">
            <span className="series-name">Not in a series</span>
            <span className="byline">
              {books.length} book{books.length === 1 ? '' : 's'}
            </span>
          </span>
        </button>

        <span className="series-meta">
          <span className="progress-line">
            <b>{readCount}</b> read
          </span>
        </span>
      </div>

      <p className="verdict muted">
        No series in the Goodreads title. A few may be series books Goodreads never
        labelled &mdash; worth a look if one of yours is missing above.
      </p>

      {open && (
        <div className="volumes" id="standalone-books">
          <ol className="volume-list">
            {books.map((book, index) => (
              <BookLine key={`${book.title}-${index}`} book={book} />
            ))}
          </ol>
        </div>
      )}
    </li>
  )
}

function BookLine({ book }: { book: Book }) {
  return (
    <li className={`volume volume-book volume-${book.shelf}`}>
      <Cover url={null} alt="" size="sm" />
      <span className="vol-main">
        <span className="vol-title">{book.title}</span>
        <span className="vol-alt">{book.author}</span>
        <span className="vol-facts">
          <span className={`chip chip-${book.shelf}`}>{SHELF_LABEL[book.shelf]}</span>
          {book.dateRead && <span className="muted">{book.dateRead}</span>}
          {book.rating !== null && <Stars rating={book.rating} />}
        </span>
      </span>
    </li>
  )
}

function SeriesRow({
  state,
  dismissed,
  onToggle,
  open,
  onOpen,
}: {
  state: SeriesState
  dismissed: boolean
  onToggle: () => void
  open: boolean
  onOpen: () => void
}) {
  const panelId = `volumes-${state.key.replace(/[^a-z0-9]+/g, '-')}`

  return (
    <li className={`series-row${dismissed ? ' is-dismissed' : ''}${open ? ' is-open' : ''}`}>
      <div className="series-head">
        <button
          type="button"
          className="disclose"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onOpen}
        >
          <span className="chevron" aria-hidden="true">
            {open ? '\u2212' : '+'}
          </span>
          <Cover url={state.coverUrl} alt="" size="lg" />
          <span className="series-id">
            <span className="series-name">{state.name}</span>
            <span className="byline">{state.author}</span>
          </span>
        </button>

        <span className="series-meta">
          <span className="progress-line">
            <b>{state.readCount}</b>
            {state.totalBooks !== null ? ` of ${state.totalBooks}` : ''}
          </span>
          <button type="button" className="ghost" onClick={onToggle}>
            {dismissed ? 'Bring back' : 'Set aside'}
          </button>
        </span>
      </div>

      <Verdict state={state} />

      {open && (
        <div className="volumes" id={panelId}>
          {state.rows.length === 0 ? (
            <p className="note">No volume list yet. Run the lookup first.</p>
          ) : (
            <ol className="volume-list">
              {state.rows.map((row) => (
                <VolumeLine key={`${row.position}-${row.title}`} row={row} />
              ))}
            </ol>
          )}
        </div>
      )}
    </li>
  )
}

/**
 * A fixed-size slot, present from first paint whether or not an image ever
 * arrives. The image never decides layout, so nothing shifts when it loads
 * and lazy loading stays safe.
 */
function Cover({ url, alt, size }: { url: string | null; alt: string; size: 'lg' | 'sm' }) {
  return (
    <span className={`cover cover-${size}`} aria-hidden={url ? undefined : true}>
      {url && <img src={url} alt={alt} loading="lazy" decoding="async" />}
    </span>
  )
}

const SHELF_LABEL: Record<string, string> = {
  read: 'Read',
  reading: 'Reading',
  to_read: 'On your list',
  dnf: 'Did not finish',
}

function VolumeLine({ row }: { row: VolumeRow }) {
  const mine = row.mine
  const shelf = mine?.shelf ?? 'none'

  return (
    <li className={`volume volume-${shelf}${row.isNext ? ' is-next' : ''}`}>
      <span className="vol-pos">#{row.position}</span>
      <Cover url={row.coverUrl} alt="" size="sm" />

      <span className="vol-main">
        <span className="vol-title">
          {row.slug ? (
            <a
              href={`https://hardcover.app/books/${row.slug}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {row.title}
            </a>
          ) : (
            row.title
          )}
        </span>
        {mine && mine.title !== row.title && (
          <span className="vol-alt">your copy: {mine.title}</span>
        )}
        <span className="vol-facts">
          {mine ? (
            <>
              <span className={`chip chip-${shelf}`}>{SHELF_LABEL[shelf]}</span>
              {mine.dateRead && <span className="muted">{mine.dateRead}</span>}
              {mine.rating !== null && <Stars rating={mine.rating} />}
            </>
          ) : (
            <span className="muted">Not in your library</span>
          )}
          {row.isNext && <span className="chip chip-next">Next up</span>}
        </span>
      </span>

      <span className="vol-date muted">
        {row.releaseDate
          ? row.publication === 'announced'
            ? `due ${row.releaseDate}`
            : row.releaseDate.slice(0, 4)
          : ''}
      </span>
    </li>
  )
}

function Stars({ rating }: { rating: number }) {
  return (
    <span className="rating" title={`${rating} of 5`}>
      {'\u2605'.repeat(rating)}
      <span className="muted">{'\u2605'.repeat(5 - rating)}</span>
    </span>
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

function firstDetail(resolved: Map<string, SeriesResult>): string | null {
  for (const entry of resolved.values()) {
    if (entry.status === 'error' && entry.detail) return entry.detail
  }
  return null
}

/**
 * A reader needs to know whether to wait, retry, or give up — not which HTTP
 * status came back. The technical detail stays in the logs.
 */
function failureMessage(detail: string | null): string {
  const text = (detail ?? '').toLowerCase()
  if (text.includes('too many') || text.includes('429')) {
    return 'Too many lookups just now. Wait a minute and try again.'
  }
  if (text.includes('not configured')) {
    return 'Series lookup is not set up on this server yet.'
  }
  return 'Could not reach the series database. Try again in a moment — nothing was lost.'
}
