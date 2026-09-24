import { useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import { parseGoodreadsCsv } from './goodreads'
import type { Book, ParseResult } from './goodreads'
import { groupIntoSeries } from './series'
import type { SeriesSummary } from './series'
import { resolveAllSeries } from './resolve'
import type { SeriesResult } from './resolve'
import { DEFAULT_VISIBLE, buildSeriesState, countTiles, isListed, sortSeriesStates, tileOf } from './state'
import { SkinPicker } from './SkinPicker.tsx'
import { LibraryShelf } from './LibraryShelf.tsx'
import { LookupPanel } from './LookupPanel.tsx'
import type { FailureKind, LookupPhase } from './LookupPanel.tsx'
import type { SeriesState, Tile, VolumeRow } from './state'
import { BoardTiles, ListHead } from './BoardTiles.tsx'

/**
 * A Goodreads export of 5,000 books is about 2 MB. Ten times that is not a
 * library, and parsing it would hang the tab with no explanation — which
 * looks exactly like the app being broken.
 */
const MAX_FILE_BYTES = 20 * 1024 * 1024

function describeSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`
}

export default function App() {
  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const [summary, setSummary] = useState<SeriesSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)

  function reset() {
    setParsed(null)
    setSummary(null)
    setError(null)
    setFileName(null)
  }

  /** Reads a CSV from anywhere: a chosen file, or the bundled sample. */
  function accept(text: string, name: string) {
    const result = parseGoodreadsCsv(text)
    if (result.books.length === 0) {
      setError('That file has no book rows. Is it the Goodreads library export?')
      reset()
      return
    }
    setParsed(result)
    setSummary(groupIntoSeries(result.books))
    setFileName(name)
  }

  /**
   * Seeing the board should not require owning a Goodreads account and doing a
   * five-minute export first.
   */
  async function loadSample() {
    setError(null)
    try {
      const response = await fetch('/sample-library.csv')
      if (!response.ok) throw new Error(String(response.status))
      accept(await response.text(), 'a sample library')
    } catch {
      setError('The sample could not be loaded. Try your own export instead.')
    }
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    setError(null)

    if (file.size > MAX_FILE_BYTES) {
      setError(
        `That file is ${describeSize(file.size)}, which is far larger than any ` +
          `Goodreads export. Is it the library export rather than something else?`,
      )
      reset()
      return
    }
    if (file.size === 0) {
      setError('That file is empty. Try exporting it again from Goodreads.')
      reset()
      return
    }

    try {
      accept(await file.text(), file.name)
    } catch {
      setError('That file could not be read. Try exporting it again from Goodreads.')
      reset()
    }
  }

  return (
    <main className="page">
      <header className="masthead">
        <h1>Loose Ends</h1>
        <p className="tagline">
          You&rsquo;ve read four. There are seven. Here&rsquo;s book five.
        </p>
        <SkinPicker />
      </header>

      <section className="intake">
        {parsed ? (
          <LibraryShelf
            name={fileName ?? 'Your export'}
            books={parsed.books}
            counts={parsed.counts}
            standalone={summary?.unmatched.length ?? 0}
            onReset={reset}
          />
        ) : (
          <>
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

        <div className="dropzone">
          {/* The input stays focusable for the keyboard; the label is what
              anyone sees, so it can carry the same weight as every other
              action on the page. */}
          <input
            type="file"
            id="export-file"
            className="file-input"
            accept=".csv"
            onChange={handleFile}
          />
          <label className="file-button" htmlFor="export-file">
            Choose your export file
          </label>

          <span className="file-or">or</span>

          <button type="button" className="ghost" onClick={loadSample}>
            Try a sample library
          </button>
        </div>

        <p className="note">
          Your library is read here in your browser. It is never uploaded and
          never stored.
        </p>
          </>
        )}
        {error && <p className="error">{error}</p>}
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
  // Every visit starts with Finished and Set aside hidden; nothing is saved.
  const [visibleTiles, setVisibleTiles] = useState<Record<Tile, boolean>>({ ...DEFAULT_VISIBLE })
  const [standaloneOpen, setStandaloneOpen] = useState(false)
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

  // Each series sits on at most one tile, so the figures add up to the list;
  // series with no tile (not looked up, failed, partial) are always listed.
  const tileCounts = countTiles(states, dismissed)
  const visible = states.filter((state) => isListed(state, dismissed, visibleTiles))
  const failedCount = [...resolved.values()].filter((entry) => entry.status === 'error').length
  const namesOn = (tile: Tile) =>
    states.filter((state) => tileOf(state, dismissed.has(state.key)) === tile).map((state) => state.name)

  function toggleTile(tile: Tile) {
    setVisibleTiles((current) => ({ ...current, [tile]: !current[tile] }))
  }

  const phase: LookupPhase = progress
    ? 'during'
    : resolved.size === 0
      ? 'before'
      : failedCount > 0
        ? 'failed'
        : 'after'

  // Map order is arrival order, so the tail is what came back last.
  const answered = [...resolved.entries()].filter(([, result]) => result.status !== 'error')
  const byKey = new Map(states.map((state) => [state.key, state]))
  const heard = answered
    .slice(-3)
    .map(([key]) => byKey.get(key))
    .filter((state): state is SeriesState => state !== undefined)
  const pendingNames = started
    .filter((group) => {
      const result = resolved.get(group.key)
      return !result || result.status === 'error'
    })
    .map((group) => group.name)
  const failedNames = states
    .filter((state) => resolved.get(state.key)?.status === 'error')
    .map((state) => state.name)

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

      <LookupPanel
        phase={phase}
        total={started.length}
        heardCount={answered.length}
        heard={heard}
        pendingNames={pendingNames}
        summary={{
          ready: tileCounts.ready,
          reading: namesOn('reading'),
          waiting: namesOn('waiting'),
          complete: namesOn('finished'),
        }}
        failedNames={failedNames}
        failure={failureKind(firstDetail(resolved))}
        onLookUp={lookUp}
        onShowResults={() =>
          document.getElementById('series-list')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      />

      {resolved.size > 0 && (
        <>
          <BoardTiles counts={tileCounts} visible={visibleTiles} onToggle={toggleTile} />
          <ListHead
            shown={visible.length}
            visible={visibleTiles}
            counts={tileCounts}
            onShowAll={() => setVisibleTiles({ ready: true, reading: true, waiting: true, finished: true, aside: true })}
          />
        </>
      )}

      <ul className="series-list" id="series-list">
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
      </ul>

      {standalone.length > 0 && (
        <StandaloneDrawer
          books={standalone}
          open={standaloneOpen}
          onToggle={() => setStandaloneOpen((value) => !value)}
        />
      )}

      {notStarted > 0 && (
        <p className="note">
          {notStarted} series in your export {notStarted === 1 ? 'has' : 'have'} nothing
          read yet, so {notStarted === 1 ? 'it is' : 'they are'} not listed here.
        </p>
      )}
    </section>
  )
}

/** Read first, then in progress, then abandoned, then the wishlist. */
const DISPLAY_RANK: Record<string, number> = { read: 0, reading: 1, dnf: 2, to_read: 3 }

/* Three books stand in for the lot on the closed drawer, in shelf colours:
   standalone books have no covers to show. */
const PREVIEW = 3

/**
 * A drawer at the end of the list rather than several hundred loose rows:
 * these are not series, and the series list is the wrong place to scatter
 * them. It is there before the lookup too — the books are known from the
 * export alone — and opens to the whole list, no inner scroll.
 */
function StandaloneDrawer({
  books,
  open,
  onToggle,
}: {
  books: Book[]
  open: boolean
  onToggle: () => void
}) {
  return (
    <section className={`drawer${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="drawer-head"
        aria-expanded={open}
        aria-controls="standalone-books"
        onClick={onToggle}
      >
        {/* Drawn, not typed: a "+" in one skin's display face is a
            different size and weight from the next one's. */}
        <span className="chevron" aria-hidden="true">
          <i className="chev" />
        </span>
        <span className="drawer-id">
          <span className="drawer-title">Not in a series</span>
          <span className="drawer-meta">
            {books.length} book{books.length === 1 ? '' : 's'} &middot; standalone
          </span>
        </span>
        {!open && (
          <span className="drawer-spines" aria-hidden="true">
            {books.slice(0, PREVIEW).map((book, index) => (
              <span key={index} className={`spine spine-${book.shelf}`} />
            ))}
          </span>
        )}
      </button>

      {open && (
        <div className="volumes" id="standalone-books">
          <p className="note drawer-note">
            No series in the Goodreads title. A few may be series books Goodreads never
            labelled &mdash; worth a look if one of yours is missing above.
          </p>
          <ol className="volume-list">
            {books.map((book, index) => (
              <BookLine key={`${book.title}-${index}`} book={book} />
            ))}
          </ol>
        </div>
      )}
    </section>
  )
}

function BookLine({ book }: { book: Book }) {
  return (
    <li className={`volume volume-book volume-${book.shelf}`}>
      <span className="vol-main">
        <span className="vol-title">
          {book.title}
          {book.author && <span className="vol-author"> &middot; {book.author}</span>}
        </span>
      </span>
      <span className={`vol-status status-${book.shelf}`}>{shelfWords(book.shelf, book.dateRead)}</span>
      <span className="vol-stars">{book.rating ? <Stars rating={book.rating} /> : null}</span>
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
  // Before the lookup there are no covers to show, so the rows don't reserve room for one.
  const lookedUp = state.status !== 'unknown'

  return (
    <li
      className={
        `series-row${dismissed ? ' is-dismissed' : ''}${open ? ' is-open' : ''}` +
        (state.status === 'unknown' ? ' is-pending' : '')
      }
    >
      <div className="series-head">
        <button
          type="button"
          className="disclose"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onOpen}
        >
          <span className="chevron" aria-hidden="true">
            <i className="chev" />
          </span>
          <Cover url={state.coverUrl} color={state.coverColor} alt="" size="lg" />
          <span className="series-id">
            <span className="series-name">{state.name}</span>
            <span className="byline">{state.author}</span>
          </span>
        </button>

        <span className="series-meta">
          <span className="progress-line">
            {state.totalBooks !== null ? (
              <>
                <b>{state.readCount}</b> of {state.totalBooks}
              </>
            ) : (
              shelfSummary(state.rows)
            )}
          </span>
          {state.status !== 'unknown' && (
            <button type="button" className="ghost" onClick={onToggle}>
              {dismissed ? 'Bring back' : 'Set aside'}
            </button>
          )}
        </span>
      </div>

      <Verdict state={state} />

      {open && (
        <div className="volumes" id={panelId}>
          {state.rows.length === 0 ? (
            <p className="note">No volume list yet. Run the lookup first.</p>
          ) : (
            <ol className={`volume-list${lookedUp ? ' has-covers' : ''}`}>
              {state.rows.map((row) => (
                <VolumeLine key={`${row.position}-${row.title}`} row={row} withCover={lookedUp} />
              ))}
            </ol>
          )}
        </div>
      )}
    </li>
  )
}

/** Rendered size in CSS pixels, mirroring .cover-lg and .cover-sm. */
const COVER_SIZE = { lg: { width: 36, height: 54 }, sm: { width: 28, height: 42 } }

/**
 * A fixed-size slot, present from first paint whether or not an image ever
 * arrives. The image never decides layout, so nothing shifts when it loads
 * and lazy loading stays safe.
 *
 * The dimensions are also on the element itself: the preload scanner reads
 * those before any stylesheet has applied, and they keep the slot correct if
 * the CSS ever fails to load.
 */
function Cover({
  url,
  color,
  alt,
  size,
}: {
  url: string | null
  color?: string | null
  alt: string
  size: 'lg' | 'sm'
}) {
  return (
    <span
      className={`cover cover-${size}`}
      aria-hidden={url ? undefined : true}
      // The book's own colour holds the slot while the image downloads, so
      // the board reads as a shelf immediately rather than a row of holes.
      style={color ? { backgroundColor: color } : undefined}
    >
      {url && (
        <img
          src={url}
          alt={alt}
          width={COVER_SIZE[size].width}
          height={COVER_SIZE[size].height}
          loading="lazy"
          decoding="async"
          // Volume thumbnails only exist inside an expanded row, below
          // everything else on the page. Nothing waits on them.
          fetchPriority={size === 'sm' ? 'low' : undefined}
        />
      )}
    </span>
  )
}

/** What the reader's own shelf says, in the words the list uses on the right. */
function shelfWords(shelf: Book['shelf'], dateRead: string | null): string {
  switch (shelf) {
    case 'read':
      return dateRead ? `read ${monthYear(dateRead)}` : 'read'
    case 'reading':
      return 'reading now'
    case 'dnf':
      return 'did not finish'
    case 'to_read':
      return 'on your list'
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2022-02-19" → "Feb 2022": the day is noise at this distance. */
function monthYear(date: string): string {
  const [year, month] = date.split('-')
  const name = MONTHS[Number(month) - 1]
  return name ? `${name} ${year}` : year
}

/** "1 read · 2 on your list" — the closed row before any lookup has run. */
function shelfSummary(rows: VolumeRow[]): string {
  const count = { read: 0, reading: 0, to_read: 0, dnf: 0 }
  for (const row of rows) if (row.mine) count[row.mine.shelf] += 1
  const parts = [
    count.read > 0 && `${count.read} read`,
    count.reading > 0 && `${count.reading} reading now`,
    count.to_read > 0 && `${count.to_read} on your list`,
    count.dnf > 0 && `${count.dnf} did not finish`,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' \u00b7 ') : 'none read'
}

/** Whole numbers are the series; 0.5, 6.5 and the like are side stories. */
function isSideStory(position: number): boolean {
  return !Number.isInteger(position)
}

/**
 * One book: number, cover (once looked up), title with its year under it,
 * then what your shelf says and your stars on the right edge, so both line
 * up down the list.
 */
function VolumeLine({ row, withCover }: { row: VolumeRow; withCover: boolean }) {
  const mine = row.mine
  const shelf = mine?.shelf ?? 'none'
  const side = isSideStory(row.position)

  const year =
    row.releaseDate && row.publication === 'announced'
      ? `due ${monthYear(row.releaseDate)}`
      : (row.releaseDate?.slice(0, 4) ?? (mine?.year ? String(mine.year) : null))
  const sub = [year, side ? 'side story' : null, mine && mine.title !== row.title ? `your copy: ${mine.title}` : null]
    .filter(Boolean)
    .join(' \u00b7 ')

  return (
    <li className={`volume volume-${shelf}${row.isNext ? ' is-next' : ''}${side ? ' is-side' : ''}`}>
      <span className="vol-pos">{row.position}</span>
      {withCover && <Cover url={row.coverUrl} color={row.coverColor} alt="" size="sm" />}

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
        {sub && <span className="vol-sub">{sub}</span>}
      </span>

      <span className={`vol-status status-${shelf}`}>{mine ? shelfWords(mine.shelf, mine.dateRead) : ''}</span>
      <span className="vol-stars">{mine?.rating ? <Stars rating={mine.rating} /> : null}</span>
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
  // Before the lookup the button already says what has not happened; five rows
  // repeating it just makes a working page look broken.
  if (state.status === 'unknown') return null
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

  const year = next.releaseDate?.slice(0, 4)
  const where = next.onYourList ? 'already on your list' : 'not in your library yet'
  const onNow =
    state.inProgressPosition !== null ? `you\u2019re on ${state.inProgressPosition}` : null
  const title = (
    <span className="next-title">
      {next.position} &middot; {next.title}
    </span>
  )

  if (next.publication === 'published') {
    return (
      <p className="verdict">
        <span className="badge badge-go">Next</span>
        {title}
        <span className="next-why">{[year, onNow ?? where].filter(Boolean).join(' \u00b7 ')}</span>
      </p>
    )
  }

  if (next.publication === 'announced' && next.releaseDate) {
    return (
      <p className="verdict">
        <span className="badge badge-soon">Due {monthYear(next.releaseDate)}</span>
        {title}
        {onNow && <span className="next-why">{onNow}</span>}
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
function failureKind(detail: string | null): FailureKind {
  const text = (detail ?? '').toLowerCase()
  if (text.includes('too many') || text.includes('429')) return 'busy'
  if (text.includes('not configured')) return 'unset'
  return 'unreachable'
}
