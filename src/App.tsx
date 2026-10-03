import { useMemo, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import { parseGoodreadsCsv } from './goodreads'
import type { Book, ParseResult } from './goodreads'
import { groupIntoSeries } from './series'
import type { SeriesSummary } from './series'
import { postWithPass, resolveAllSeries } from './resolve'
import type { SeriesResult } from './resolve'
import { lookUpWithAi, readAiCached } from './aiResolve.ts'
import type { AiAllowance, AiSeriesResult, AiStop } from './aiResolve.ts'
import { buildAiSeriesState } from './aiState.ts'
import { AiLookupPanel } from './AiLookupPanel.tsx'
import type { AiPhase } from './AiLookupPanel.tsx'
import { AiAudioMark, AiCover, NoCover, SourceLink, UnknownDate } from './AiParts.tsx'
import { normalise } from './shared/aiLookup.ts'
import { DEFAULT_VISIBLE, buildSeriesState, countTiles, isListed, sortSeriesStates, tileOf } from './state'
import { SkinPicker } from './SkinPicker.tsx'
import { LibraryShelf } from './LibraryShelf.tsx'
import { LookupPanel } from './LookupPanel.tsx'
import type { FailureKind, LookupPhase } from './LookupPanel.tsx'
import type { AiNote, SeriesState, Tile, VolumeRow } from './state'
import { BoardTiles, ListHead } from './BoardTiles.tsx'
import { SNIFF_BYTES, checkParsed, leftOutNote, sniffExport, sniffText } from './checkExport'
import { FileError } from './FileError.tsx'
import { MAX_FAVOURITES, addFavourite, asideKeys, bringBack, hasChoices, isFull, presentFavourites, removeFavourite, setAside } from './choices'
import type { Choices } from './choices'
import { useChoices } from './useChoices'
import type { IntakeProblem } from './FileError.tsx'

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
  const [problem, setProblem] = useState<IntakeProblem | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [leftOut, setLeftOut] = useState<string | null>(null)
  const [choices, updateChoices, forgetChoices] = useChoices()
  // Which lookup the board is showing. Every library opens on Hardcover.
  const [source, setSource] = useState<Source>('hardcover')

  /** Back to the intake. Leaves any error in place: it explains why we're here. */
  function clearLibrary() {
    setParsed(null)
    setSummary(null)
    setLeftOut(null)
    setSource('hardcover')
  }

  function reset() {
    clearLibrary()
    setProblem(null)
    setFileName(null)
  }

  function refuse(why: IntakeProblem, name: string | null) {
    clearLibrary()
    setFileName(name)
    setProblem(why)
  }

  /** Reads a CSV from anywhere: a chosen file, or the bundled sample. */
  function accept(text: string, name: string) {
    const result = parseGoodreadsCsv(text)
    const wrong = checkParsed(result)
    if (wrong) {
      refuse(wrong, name)
      return
    }
    setProblem(null)
    setParsed(result)
    setSummary(groupIntoSeries(result.books))
    setFileName(name)
    setLeftOut(leftOutNote(result))
  }

  /**
   * Seeing the board should not require owning a Goodreads account and doing a
   * five-minute export first.
   */
  async function loadSample() {
    setProblem(null)
    try {
      const response = await fetch('/sample-library.csv')
      if (!response.ok) throw new Error(String(response.status))
      const text = await response.text()
      const wrong = sniffText(text)
      if (wrong) throw new Error(wrong.kind)
      accept(text, 'a sample library')
    } catch {
      refuse({ kind: 'sample' }, null)
    }
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.target
    const file = input.files?.[0]
    // Choosing the same file again after fixing it must still fire a change.
    input.value = ''
    if (!file) return
    setProblem(null)

    if (file.size > MAX_FILE_BYTES) {
      refuse({ kind: 'too-big', size: describeSize(file.size) }, file.name)
      return
    }

    try {
      // Check the start before reading the rest: a wrong file is refused at
      // once, whatever its size.
      const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer())
      const wrong = sniffExport(head)
      if (wrong) {
        refuse(wrong, file.name)
        return
      }
      accept(await file.text(), file.name)
    } catch {
      refuse({ kind: 'unreadable' }, file.name)
    }
  }

  return (
    <main className="page">
      <header className="masthead">
        <h1>Loose Ends</h1>
        <p className="tagline">
          <span>You&rsquo;ve read four.</span> <span>There are seven.</span>{' '}
          <span>Here&rsquo;s book five.</span>
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
            leftOut={leftOut}
            onReset={reset}
            remembered={hasChoices(choices)}
            onForget={forgetChoices}
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

        {problem && <FileError problem={problem} fileName={fileName} />}

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
            {problem ? 'Choose a different file' : 'Choose your export file'}
          </label>

          <span className="file-or">or</span>

          <button type="button" className="ghost" onClick={loadSample}>
            Try a sample library
          </button>
        </div>

        <p className="note">
          Your library is read here in your browser. It is never uploaded and
          never stored. Favourites and set-asides are remembered in this browser.
        </p>
          </>
        )}
      </section>

      {summary && (
        <SeriesBoard
          summary={summary}
          choices={choices}
          onChoices={updateChoices}
          source={source}
          onSource={setSource}
        />
      )}

      {summary && source === 'ai' ? (
        <footer className="colophon">
          AI lookup is an experiment. Series names and authors are sent to{' '}
          <a href="https://tavily.com" target="_blank" rel="noopener noreferrer">
            Tavily
          </a>{' '}
          to search the web, and to Cloudflare Workers AI to read what it finds. Book
          lists come from the linked pages and may be wrong. Your books and ratings stay
          in this browser, and so do your favourites and set-asides. Opening this tab runs
          Cloudflare Turnstile, a quick check that you&rsquo;re a person; it sees your
          browser, not your books.
        </footer>
      ) : (
        <footer className="colophon">
          Series data and covers from{' '}
          <a href="https://hardcover.app" target="_blank" rel="noopener noreferrer">
            Hardcover
          </a>
          . Only series names and authors are sent, to look them up; your books and
          ratings stay in this browser, and so do your favourites and set-asides.
          Pressing Look up runs Cloudflare Turnstile, a quick check that you&rsquo;re a
          person; it sees your browser, not your books.
        </footer>
      )}
    </main>
  )
}

/** Where the board's series data comes from. Two lookups, never mixed. */
type Source = 'hardcover' | 'ai'

const postAi = (payload: unknown) => postWithPass('/api/ai-series', payload)

function SeriesBoard({
  summary,
  choices,
  onChoices,
  source,
  onSource,
}: {
  summary: SeriesSummary
  choices: Choices
  onChoices: (update: (current: Choices) => Choices) => void
  source: Source
  onSource: (source: Source) => void
}) {
  const started = useMemo(
    () => summary.groups.filter((group) => group.readCount > 0),
    [summary],
  )
  const [resolved, setResolved] = useState<Map<string, SeriesResult>>(new Map())
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  /** Series the lookup set aside by itself: abandoned part-way (a DNF). */
  const [autoAside, setAutoAside] = useState<Set<string>>(new Set())
  // Every visit starts with Finished and Set aside hidden; the tiles are not saved.
  const [visibleTiles, setVisibleTiles] = useState<Record<Tile, boolean>>({ ...DEFAULT_VISIBLE })
  const [standaloneOpen, setStandaloneOpen] = useState(false)
  const [openKey, setOpenKey] = useState<string | null>(null)

  // The AI lookup keeps everything of its own: results, progress, and the
  // series it set aside. Only the reader's choices are shared between tabs.
  const [aiResolved, setAiResolved] = useState<Map<string, AiSeriesResult>>(new Map())
  /** null until the tab is first opened; then whether the cache has been read. */
  const [aiChecked, setAiChecked] = useState<boolean | null>(null)
  const [aiRunning, setAiRunning] = useState(false)
  const [aiCurrent, setAiCurrent] = useState<string | null>(null)
  const [aiStop, setAiStop] = useState<AiStop | null>(null)
  const [aiAllowance, setAiAllowance] = useState<AiAllowance | null>(null)
  /** Keys answered since the button was last pressed, in the order they came. */
  const [aiHeard, setAiHeard] = useState<string[]>([])
  /** Keys that were already known when the tab opened. */
  const [aiKnown, setAiKnown] = useState<Set<string>>(new Set())
  const [aiAutoAside, setAiAutoAside] = useState<Set<string>>(new Set())
  const ai = source === 'ai'

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
    setAutoAside(
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

  /** A DNF part-way through a series the AI found: set aside, as on the Hardcover tab. */
  function setAsideAbandoned(results: Map<string, AiSeriesResult>) {
    setAiAutoAside(
      new Set(
        started
          .filter((group) => {
            if (!group.hasDnf) return false
            const state = buildAiSeriesState(group, results.get(group.key))
            return state.status !== 'unknown' && state.status !== 'complete'
          })
          .map((group) => group.key),
      ),
    )
  }

  /**
   * The first time the AI tab is opened: show what has been looked up
   * before, by this reader or anyone else. One request, and it costs none
   * of the allowance, so it needs no button.
   */
  async function openAiTab() {
    onSource('ai')
    if (aiChecked !== null) return
    setAiChecked(false)
    const { found, allowance } = await readAiCached(
      started.map((group) => ({ key: group.key, name: group.name, author: group.author })),
      postAi,
    )
    setAiResolved(found)
    setAiKnown(new Set(found.keys()))
    setAiAllowance(allowance)
    setAsideAbandoned(found)
    setAiChecked(true)
  }

  /** The rest, one series at a time, in the order the board lists them. */
  async function lookUpAi() {
    if (aiRunning) return
    const results = new Map(aiResolved)
    const pending = aiStates
      .filter((state) => {
        const result = results.get(state.key)
        return !result || result.status === 'error'
      })
      .map((state) => ({ key: state.key, name: state.name, author: state.author }))
    if (pending.length === 0) return

    setAiRunning(true)
    setAiStop(null)
    setAiHeard([])
    const { stopped } = await lookUpWithAi(
      pending,
      postAi,
      {
        onStart: (item) => setAiCurrent(item.name),
        onResult: (item, result, allowance) => {
          results.set(item.key, result)
          setAiResolved(new Map(results))
          if (result.status !== 'error') setAiHeard((heard) => [...heard, item.key])
          if (allowance) setAiAllowance(allowance)
        },
      },
      // The dev server has no rate limit to stay under.
      import.meta.env.DEV ? 0 : undefined,
    )
    setAiCurrent(null)
    setAiStop(stopped)
    setAiRunning(false)
    setAsideAbandoned(results)
  }

  const hardcoverStates = useMemo(
    () => sortSeriesStates(started.map((g) => buildSeriesState(g, resolved.get(g.key)))),
    [started, resolved],
  )
  const aiStates = useMemo(
    () => sortSeriesStates(started.map((g) => buildAiSeriesState(g, aiResolved.get(g.key)))),
    [started, aiResolved],
  )
  const states = ai ? aiStates : hardcoverStates

  const present = useMemo(() => new Set(started.map((group) => group.key)), [started])
  const dismissed = useMemo(
    () => asideKeys(choices, ai ? aiAutoAside : autoAside),
    [choices, ai, aiAutoAside, autoAside],
  )
  const favourites = new Set(presentFavourites(choices, present))
  const full = isFull(choices, present)

  // Each series sits on at most one tile, so the figures add up to the list;
  // series with no tile (not looked up, failed, partial) are always listed.
  const tileCounts = countTiles(states, dismissed)
  // A favourite is always in view, whichever tiles are switched off, and
  // pinned to the top in the board's usual order.
  const visible = states.filter(
    (state) => favourites.has(state.key) || isListed(state, dismissed, visibleTiles),
  )
  const pinned = visible.filter((state) => favourites.has(state.key))
  const rest = visible.filter((state) => !favourites.has(state.key))
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

  // The AI panel's figures. A series is pending until it has an answer the
  // server keeps: a list, or a miss. A failure can be asked about again.
  const aiPending = started.filter((group) => {
    const result = aiResolved.get(group.key)
    return !result || result.status === 'error'
  }).length
  const aiByKey = new Map(aiStates.map((state) => [state.key, state]))
  const aiFound = aiStates.filter((state) => state.status !== 'unknown')
  const aiPhase: AiPhase =
    aiChecked !== true
      ? 'checking'
      : aiRunning
        ? 'during'
        : aiStop
          ? 'stopped'
          : aiPending === 0
            ? 'after'
            : 'before'
  // Tiles and counts appear once a tab has something to count.
  const hasResults = ai ? aiFound.length > 0 : resolved.size > 0

  function toggleAside(key: string) {
    onChoices((current) =>
      dismissed.has(key) ? bringBack(current, key) : setAside(current, key, present),
    )
  }

  function toggleFavourite(key: string) {
    onChoices((current) =>
      favourites.has(key) ? removeFavourite(current, key, present) : addFavourite(current, key, present),
    )
  }

  const row = (state: SeriesState) => (
    <SeriesRow
      key={state.key}
      state={state}
      dismissed={dismissed.has(state.key)}
      onToggle={() => toggleAside(state.key)}
      favourite={favourites.has(state.key)}
      canFavourite={!full}
      onFavourite={() => toggleFavourite(state.key)}
      open={openKey === state.key}
      onOpen={() => setOpenKey(openKey === state.key ? null : state.key)}
      ai={ai}
    />
  )

  return (
    <section className="board">
      <h2>Series</h2>

      <div className="source-tabs" role="tablist" aria-label="Where series data comes from">
        <button
          type="button"
          role="tab"
          id="tab-hardcover"
          className="source-tab"
          aria-selected={!ai}
          aria-controls="series-panel"
          onClick={() => onSource('hardcover')}
        >
          Hardcover
        </button>
        <button
          type="button"
          role="tab"
          id="tab-ai"
          className="source-tab"
          aria-selected={ai}
          aria-controls="series-panel"
          onClick={openAiTab}
        >
          AI lookup <span className="exp">experimental</span>
        </button>
      </div>

      <div
        className="tab-panel"
        id="series-panel"
        role="tabpanel"
        aria-labelledby={ai ? 'tab-ai' : 'tab-hardcover'}
      >
      {ai ? (
        <AiLookupPanel
          phase={aiPhase}
          total={started.length}
          foundCount={aiFound.length}
          pendingCount={aiPending}
          currentName={aiCurrent}
          heard={aiHeard
            .slice(-3)
            .map((key) => aiByKey.get(key))
            .filter((state): state is SeriesState => state !== undefined)}
          knownNames={aiStates.filter((state) => aiKnown.has(state.key)).map((state) => state.name)}
          ready={tileCounts.ready}
          missedNames={aiStates
            .filter((state) => state.ai?.miss === 'not_confirmed' || state.ai?.miss === 'not_found')
            .map((state) => state.name)}
          stop={aiStop}
          allowance={aiAllowance}
          onLookUp={lookUpAi}
        />
      ) : (
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
      )}

      {hasResults && (
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

      <div className="series-lists" id="series-list">
        {pinned.length === 0 ? (
          visible.length > 0 && (
            <p className="fav-hint">
              <HeartIcon />
              Heart up to {MAX_FAVOURITES} series to keep them at the top.
            </p>
          )
        ) : (
          <>
            <h3 className="list-label fav-label">
              Favourites{' '}
              <span className="list-label-note">
                {pinned.length} of {MAX_FAVOURITES}
              </span>
            </h3>
            <ul className="series-list">{pinned.map(row)}</ul>
            {rest.length > 0 && (
              <h3 className="list-label">
                Everything else
                {full && (
                  <span className="list-label-note">
                    Your top {MAX_FAVOURITES} is full &mdash; remove a heart above to choose another.
                  </span>
                )}
              </h3>
            )}
          </>
        )}
        {rest.length > 0 && <ul className="series-list">{rest.map(row)}</ul>}
      </div>
      </div>

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

/** Drawn, not typed: the heart glyph differs in every font and emoji set. */
function HeartIcon() {
  return (
    <svg className="heart-icon" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 20.3c-.3 0-7.6-4.5-9.4-9C1.3 8 3.3 4.6 6.9 4.6c2.1 0 3.7 1.2 5.1 3 1.4-1.8 3-3 5.1-3 3.6 0 5.6 3.4 4.3 6.7-1.8 4.5-9.1 9-9.4 9z" />
    </svg>
  )
}

function SeriesRow({
  state,
  dismissed,
  onToggle,
  favourite,
  canFavourite,
  onFavourite,
  open,
  onOpen,
  ai,
}: {
  state: SeriesState
  dismissed: boolean
  onToggle: () => void
  favourite: boolean
  /** False when the top five is full: the heart is not offered at all. */
  canFavourite: boolean
  onFavourite: () => void
  open: boolean
  onOpen: () => void
  /** On the AI tab: made-up covers, source links, and no Hardcover links. */
  ai: boolean
}) {
  const panelId = `volumes-${state.key.replace(/[^a-z0-9]+/g, '-')}`
  // Before the lookup there are no covers to show, so the rows don't reserve room for one.
  const lookedUp = state.status !== 'unknown'

  return (
    <li
      className={
        // Faded only once the lookup can offer "bring back" beside it.
        `series-row${dismissed && lookedUp ? ' is-dismissed' : ''}${favourite ? ' is-favourite' : ''}${open ? ' is-open' : ''}` +
        // On the AI tab found and unfound series share one list, so an
        // unfound one keeps a cover-sized slot and the names stay in line.
        (state.status === 'unknown' ? (ai ? ' is-unfound' : ' is-pending') : '')
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
          {!ai ? (
            <Cover url={state.coverUrl} color={state.coverColor} alt="" size="lg" />
          ) : lookedUp ? (
            <AiCover name={state.name} />
          ) : (
            <NoCover />
          )}
          <span className="series-id">
            <span className="series-name">
              {state.name}
              {state.rows.some((row) => row.hasAudio) && (
                <AudioMark label={ai ? 'Audiobooks mentioned on the source pages' : 'Has audiobooks'} />
              )}
            </span>
            <span className="byline">{state.author}</span>
          </span>
        </button>

        <span className="series-meta">
          <span className="meta-top">
            {favourite || canFavourite ? (
              // Outside the open/close button on purpose: a button cannot
              // sit inside another one.
              <button
                type="button"
                className={`heart${favourite ? ' is-on' : ''}`}
                aria-pressed={favourite}
                aria-label={`Favourite: ${state.name}`}
                onClick={onFavourite}
              >
                <HeartIcon />
              </button>
            ) : (
              // Keeps the count where it was when the other hearts step away.
              <span className="heart-slot" aria-hidden="true" />
            )}
            <span className="progress-line">
              {state.totalBooks !== null ? (
                <>
                  <b>{state.readCount}</b> of {state.totalBooks}
                </>
              ) : (
                shelfSummary(state.rows)
              )}
            </span>
          </span>
          {state.status !== 'unknown' && (
            // A quiet word, not a button: it's the thing you do least, so it
            // shouldn't outweigh the next book.
            <button
              type="button"
              className="aside-link"
              aria-label={`${dismissed ? 'Bring back' : 'Set aside'} ${state.name}`}
              onClick={onToggle}
            >
              {dismissed ? 'bring back' : 'set aside'}
            </button>
          )}
        </span>
      </div>

      <Verdict state={state} />

      {open && (
        <div className="volumes" id={panelId}>
          {lookedUp && state.ai?.readingOrder && (
            <p className="order-note">
              <span className="order-label">Reading order</span>
              <span>
                {state.ai.readingOrder.note} <SourceLink url={state.ai.readingOrder.url} />
              </span>
            </p>
          )}
          {state.rows.length === 0 ? (
            <p className="note">No volume list yet. Run the lookup first.</p>
          ) : (
            // The AI lookup finds no covers, so its list keeps no room for them.
            <ol className={`volume-list${lookedUp && !ai ? ' has-covers' : ''}`}>
              {state.rows.map((row) => (
                <VolumeLine
                  key={`${row.position}-${row.title}`}
                  row={row}
                  withCover={lookedUp && !ai}
                  ai={ai && lookedUp}
                />
              ))}
            </ol>
          )}
          {lookedUp && state.ai?.checkedAt && (
            <p className="ai-stamp">
              Found by AI on {dayMonthYear(state.ai.checkedAt)}, from the pages linked above. It
              can be wrong.
            </p>
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

/** "14 Oct": for a day close enough that the year goes without saying. */
function dayMonth(date: string): string {
  const [, month, day] = date.split('-')
  const name = MONTHS[Number(month) - 1]
  return name && day ? `${Number(day)} ${name}` : date
}

/** "12 Mar 2027": an audiobook date is usually a real day, so say the day. */
function dayMonthYear(date: string): string {
  const [year, month, day] = date.split('-')
  const name = MONTHS[Number(month) - 1]
  return name && day ? `${Number(day)} ${name} ${year}` : monthYear(date)
}

/**
 * Headphones, drawn rather than an emoji: an emoji is a different picture on
 * every device and ignores the skin. Labelled for screen readers, since it
 * is information, not decoration.
 */
function AudioMark({ label }: { label: string }) {
  return (
    <span className="audio-mark" role="img" aria-label={label} title={label}>
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 15v-3a8 8 0 0 1 16 0v3" />
        <rect x="3" y="14" width="4.5" height="7" rx="1.5" />
        <rect x="16.5" y="14" width="4.5" height="7" rx="1.5" />
      </svg>
    </span>
  )
}

/** What the mark on one book says when you hover it or hear it. */
function audioLabel(row: VolumeRow): string {
  return row.audioDate ? `Audiobook due ${dayMonthYear(row.audioDate)}` : 'Audiobook available'
}

/** Optional, and only when there is one: "audiobook 12 Mar 2027". */
function audioWords(audioDate: string | null): string | null {
  return audioDate ? `audiobook ${dayMonthYear(audioDate)}` : null
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
function VolumeLine({ row, withCover, ai }: { row: VolumeRow; withCover: boolean; ai: boolean }) {
  const mine = row.mine
  const shelf = mine?.shelf ?? 'none'
  const side = isSideStory(row.position)

  const year =
    row.releaseDate && row.publication === 'announced'
      ? `due ${monthYear(row.releaseDate)}`
      : (row.releaseDate?.slice(0, 4) ?? (mine?.year ? String(mine.year) : null))
  // On the AI tab the reader's copy was matched by title, so it only counts
  // as a different title when more than case or punctuation differs.
  const otherTitle =
    mine && (ai ? normalise(mine.title) !== normalise(row.title) : mine.title !== row.title)
      ? `your copy: ${mine.title}`
      : null
  const parts: ReactNode[] = [
    // A book the AI list has, with no date on any page read: say so, rather
    // than nothing, which would look like an oversight.
    year ?? (ai && row.sourceUrl ? <UnknownDate /> : null),
    audioWords(row.audioDate),
    side ? 'side story' : null,
    otherTitle,
    // Every book on the AI tab says where it was read.
    ai && row.sourceUrl ? (
      <>
        from <SourceLink url={row.sourceUrl} />
      </>
    ) : null,
  ].filter(Boolean)
  const sub =
    parts.length > 0
      ? parts.map((part, index) => (
          <span key={index}>
            {index > 0 && ' \u00b7 '}
            {part}
          </span>
        ))
      : null

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
          {row.hasAudio && (ai ? <AiAudioMark audio={row.audio} /> : <AudioMark label={audioLabel(row)} />)}
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
  // repeating it just makes a working page look broken. On the AI tab a
  // series that was asked about and has no list says why.
  if (state.status === 'unknown') return state.ai?.miss ? <MissVerdict note={state.ai} /> : null
  if (state.status === 'reading') {
    return <p className="verdict muted">You&rsquo;re reading it now</p>
  }
  if (state.status === 'complete') {
    // A list read off the web often stops short of the newest book, so the
    // AI tab claims no more than it knows.
    return (
      <p className="verdict muted">
        {state.ai ? 'You’ve read every book AI found' : 'You’ve finished it'}
      </p>
    )
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
        <span className="next-why">
          {[year, onNow ?? where, audioWords(next.audioDate)].filter(Boolean).join(' \u00b7 ')}
        </span>
      </p>
    )
  }

  if (next.publication === 'announced' && next.releaseDate) {
    return (
      <p className="verdict">
        <span className="badge badge-soon">Due {monthYear(next.releaseDate)}</span>
        {title}
        {(onNow || next.audioDate) && (
          <span className="next-why">{[onNow, audioWords(next.audioDate)].filter(Boolean).join(' \u00b7 ')}</span>
        )}
      </p>
    )
  }

  return (
    <p className="verdict">
      <span className="badge badge-wait">No date yet</span>
      {title}
      {next.audioDate && <span className="next-why">{audioWords(next.audioDate)}</span>}
    </p>
  )
}

/** Why the AI tab has no list for a series, and when that may change. */
function MissVerdict({ note }: { note: AiNote }) {
  const again = note.retryAfter ? ` Can be looked up again from ${dayMonth(note.retryAfter)}.` : ''
  const [label, text] =
    note.miss === 'not_confirmed'
      ? ['Not confirmed', `The pages found didn’t agree on the books.${again}`]
      : note.miss === 'not_found'
        ? ['Not found', `The search found nothing about this series.${again}`]
        : note.miss === 'allowance'
          ? ['Waiting', 'Today’s shared allowance ran out before this one.']
          : note.miss === 'month'
            ? ['Waiting', 'This month’s searches ran out before this one.']
            : ['No answer', 'The lookup couldn’t be reached for this one.']
  return (
    <p className="verdict">
      <span className="badge badge-wait">{label}</span>
      <span className="next-why">{text}</span>
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
  if (text.includes('person')) return 'check'
  if (text.includes('daily')) return 'budget'
  return 'unreachable'
}
