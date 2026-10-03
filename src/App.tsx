import { Fragment, useMemo, useState } from 'react'
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
import type { IntakeProblem } from './checkExport'
import type { Messages } from './i18n/index.ts'
import { dayMonth, dayMonthYear, monthYear } from './dates.ts'
import { FileError } from './FileError.tsx'
import { useLanguage } from './language.ts'
import { LanguagePicker } from './LanguagePicker.tsx'
import { Rich } from './Rich.tsx'
import { MAX_FAVOURITES, addFavourite, asideKeys, bringBack, hasChoices, isFull, presentFavourites, removeFavourite, setAside } from './choices'
import type { Choices } from './choices'
import { useChoices } from './useChoices'

/**
 * A Goodreads export of 5,000 books is about 2 MB. Ten times that is not a
 * library, and parsing it would hang the tab with no explanation — which
 * looks exactly like the app being broken.
 */
const MAX_FILE_BYTES = 20 * 1024 * 1024

/** A link that opens in a new tab, for the tags inside translated sentences. */
const linkTo = (href: string) => (label: string) => (
  <a href={href} target="_blank" rel="noopener noreferrer">
    {label}
  </a>
)

export default function App() {
  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const [summary, setSummary] = useState<SeriesSummary | null>(null)
  const [problem, setProblem] = useState<IntakeProblem | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  // The bundled sample has no file name; what it is called depends on the
  // language, so the fact is kept here and the words are chosen on render.
  const [sample, setSample] = useState(false)
  const { t } = useLanguage()
  const [choices, updateChoices, forgetChoices] = useChoices()
  // Which lookup the board is showing. Every library opens on Hardcover.
  // Pattern: lifting state up. The board and the footer both depend on the
  // open tab, so the state lives here, in their nearest common parent.
  const [source, setSource] = useState<Source>('hardcover')

  /** Back to the intake. Leaves any error in place: it explains why we're here. */
  function clearLibrary() {
    setParsed(null)
    setSummary(null)
    setSample(false)
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
  function accept(text: string, name: string | null) {
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
    setSample(name === null)
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
      accept(text, null)
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
      refuse({ kind: 'too-big', bytes: file.size }, file.name)
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
          {t.masthead.tagline.map((line, index) => (
            <Fragment key={index}>
              {index > 0 && ' '}
              <span>{line}</span>
            </Fragment>
          ))}
        </p>
        <div className="prefs">
          <LanguagePicker />
          <SkinPicker />
        </div>
      </header>

      <section className="intake">
        {parsed ? (
          <LibraryShelf
            name={sample ? t.shelf.sampleName : (fileName ?? t.shelf.exportName)}
            books={parsed.books}
            counts={parsed.counts}
            standalone={summary?.unmatched.length ?? 0}
            leftOut={leftOutNote(parsed, t)}
            onReset={reset}
            remembered={hasChoices(choices)}
            onForget={forgetChoices}
          />
        ) : (
          <>
        <h2>{t.intake.heading}</h2>

        <ol className="how">
          {t.intake.steps.map((step, index) => (
            <li key={index}>
              <Rich text={step} tags={{ b: (name) => <b>{name}</b> }} />
            </li>
          ))}
        </ol>
        <p className="note">{t.intake.desktopOnly}</p>

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
            {problem ? t.intake.chooseAnother : t.intake.choose}
          </label>

          <span className="file-or">{t.intake.or}</span>

          <button type="button" className="ghost" onClick={loadSample}>
            {t.intake.sample}
          </button>
        </div>

        <p className="note">{t.intake.privacy}</p>
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

      <footer className="colophon">
        {summary && source === 'ai' ? (
          <Rich text={t.footer.ai} tags={{ a: linkTo('https://tavily.com') }} />
        ) : (
          <Rich text={t.footer.hardcover} tags={{ a: linkTo('https://hardcover.app') }} />
        )}
      </footer>
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
  const { t } = useLanguage()
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

  // Each tab's list, in board order. Worked out here, above the lookups that
  // read them: the AI lookup asks about series in this order.
  // Technique: derived state. The lists are never stored; they are computed
  // from the results, so the two cannot disagree. useMemo keeps the last
  // answer until `started` or the results change.
  const hardcoverStates = useMemo(
    () => sortSeriesStates(started.map((g) => buildSeriesState(g, resolved.get(g.key)))),
    [started, resolved],
  )
  const aiStates = useMemo(
    () => sortSeriesStates(started.map((g) => buildAiSeriesState(g, aiResolved.get(g.key)))),
    [started, aiResolved],
  )
  const states = ai ? aiStates : hardcoverStates

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
      <h2>{t.board.heading}</h2>

      <div className="source-tabs" role="tablist" aria-label={t.board.sources}>
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
          {t.board.aiTab} <span className="exp">{t.board.experimental}</span>
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
              {t.board.heartHint(MAX_FAVOURITES)}
            </p>
          )
        ) : (
          <>
            <h3 className="list-label fav-label">
              {t.board.favourites}{' '}
              <span className="list-label-note">{t.board.favouritesCount(pinned.length, MAX_FAVOURITES)}</span>
            </h3>
            <ul className="series-list">{pinned.map(row)}</ul>
            {rest.length > 0 && (
              <h3 className="list-label">
                {t.board.everythingElse}
                {full && <span className="list-label-note">{t.board.favouritesFull(MAX_FAVOURITES)}</span>}
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

      {notStarted > 0 && <p className="note">{t.board.notStarted(notStarted)}</p>}
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
  const { t } = useLanguage()
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
          <span className="drawer-title">{t.board.standaloneTitle}</span>
          <span className="drawer-meta">{t.board.standaloneMeta(books.length)}</span>
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
          <p className="note drawer-note">{t.board.standaloneNote}</p>
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
  const { t } = useLanguage()
  return (
    <li className={`volume volume-book volume-${book.shelf}`}>
      <span className="vol-main">
        <span className="vol-title">
          {book.title}
          {book.author && <span className="vol-author"> &middot; {book.author}</span>}
        </span>
      </span>
      <span className={`vol-status status-${book.shelf}`}>{shelfWords(t, book.shelf, book.dateRead)}</span>
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
  const { t } = useLanguage()
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
                <AudioMark label={ai ? t.row.hasAudioAi : t.row.hasAudio} />
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
                aria-label={t.row.favourite(state.name)}
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
                  <b>{state.readCount}</b> {t.row.ofTotal(state.totalBooks)}
                </>
              ) : (
                shelfSummary(t, state.rows)
              )}
            </span>
          </span>
          {state.status !== 'unknown' && (
            // A quiet word, not a button: it's the thing you do least, so it
            // shouldn't outweigh the next book.
            <button
              type="button"
              className="aside-link"
              aria-label={dismissed ? t.row.bringBackNamed(state.name) : t.row.setAsideNamed(state.name)}
              onClick={onToggle}
            >
              {dismissed ? t.row.bringBack : t.row.setAside}
            </button>
          )}
        </span>
      </div>

      <Verdict state={state} />

      {open && (
        <div className="volumes" id={panelId}>
          {lookedUp && state.ai?.readingOrder && (
            <p className="order-note">
              <span className="order-label">{t.row.readingOrder}</span>
              <span>
                {state.ai.readingOrder.note} <SourceLink url={state.ai.readingOrder.url} />
              </span>
            </p>
          )}
          {state.rows.length === 0 ? (
            <p className="note">{t.row.noVolumes}</p>
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
            <p className="ai-stamp">{t.row.foundByAi(dayMonthYear(state.ai.checkedAt, t.months))}</p>
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
function shelfWords(t: Messages, shelf: Book['shelf'], dateRead: string | null): string {
  return t.volume.shelf(shelf, dateRead ? monthYear(dateRead, t.months) : null)
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
function audioLabel(t: Messages, row: VolumeRow): string {
  return row.audioDate ? t.volume.audioDue(dayMonthYear(row.audioDate, t.months)) : t.volume.audioAvailable
}

/** Optional, and only when there is one: "audiobook 12 Mar 2027". */
function audioWords(t: Messages, audioDate: string | null): string | null {
  return audioDate ? t.volume.audioOn(dayMonthYear(audioDate, t.months)) : null
}

/** "1 read · 2 on your list" — the closed row before any lookup has run. */
function shelfSummary(t: Messages, rows: VolumeRow[]): string {
  const count = { read: 0, reading: 0, to_read: 0, dnf: 0 }
  for (const row of rows) if (row.mine) count[row.mine.shelf] += 1
  return t.row.shelfSummary(count)
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
  const { t } = useLanguage()
  const mine = row.mine
  const shelf = mine?.shelf ?? 'none'
  const side = isSideStory(row.position)

  const year =
    row.releaseDate && row.publication === 'announced'
      ? t.volume.due(monthYear(row.releaseDate, t.months))
      : (row.releaseDate?.slice(0, 4) ?? (mine?.year ? String(mine.year) : null))
  // On the AI tab the reader's copy was matched by title, so it only counts
  // as a different title when more than case or punctuation differs.
  const otherTitle =
    mine && (ai ? normalise(mine.title) !== normalise(row.title) : mine.title !== row.title)
      ? t.volume.yourCopy(mine.title)
      : null
  const parts: ReactNode[] = [
    // A book the AI list has, with no date on any page read: say so, rather
    // than nothing, which would look like an oversight.
    year ?? (ai && row.sourceUrl ? <UnknownDate key="date" /> : null),
    audioWords(t, row.audioDate),
    side ? t.volume.sideStory : null,
    otherTitle,
    // Every book on the AI tab says where it was read.
    ai && row.sourceUrl ? (
      <span key="source">
        {t.volume.from} <SourceLink url={row.sourceUrl} />
      </span>
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
          {row.hasAudio && (ai ? <AiAudioMark audio={row.audio} /> : <AudioMark label={audioLabel(t, row)} />)}
        </span>
        {sub && <span className="vol-sub">{sub}</span>}
      </span>

      <span className={`vol-status status-${shelf}`}>{mine ? shelfWords(t, mine.shelf, mine.dateRead) : ''}</span>
      <span className="vol-stars">{mine?.rating ? <Stars rating={mine.rating} /> : null}</span>
    </li>
  )
}

function Stars({ rating }: { rating: number }) {
  const { t } = useLanguage()
  return (
    <span className="rating" title={t.volume.stars(rating)}>
      {'\u2605'.repeat(rating)}
      <span className="muted">{'\u2605'.repeat(5 - rating)}</span>
    </span>
  )
}

function Verdict({ state }: { state: SeriesState }) {
  const { t } = useLanguage()
  const words = t.verdict
  // Before the lookup the button already says what has not happened; five rows
  // repeating it just makes a working page look broken. On the AI tab a
  // series that was asked about and has no list says why.
  if (state.status === 'unknown') return state.ai?.miss ? <MissVerdict note={state.ai} /> : null
  if (state.status === 'reading') {
    return <p className="verdict muted">{words.readingNow}</p>
  }
  if (state.status === 'complete') {
    // A list read off the web often stops short of the newest book, so the
    // AI tab claims no more than it knows.
    return <p className="verdict muted">{state.ai ? words.finishedAi : words.finished}</p>
  }
  if (state.status === 'partial') {
    return <p className="verdict muted">{words.partial}</p>
  }

  const next = state.next
  if (!next) return null

  const year = next.releaseDate?.slice(0, 4)
  const where = next.onYourList ? words.onYourList : words.notInLibrary
  const onNow = state.inProgressPosition !== null ? words.youAreOn(state.inProgressPosition) : null
  const audio = audioWords(t, next.audioDate)
  const title = (
    <span className="next-title">
      {next.position} &middot; {next.title}
    </span>
  )

  if (next.publication === 'published') {
    return (
      <p className="verdict">
        <span className="badge badge-go">{words.next}</span>
        {title}
        <span className="next-why">
          {[year, onNow ?? where, audio].filter(Boolean).join(' \u00b7 ')}
        </span>
      </p>
    )
  }

  if (next.publication === 'announced' && next.releaseDate) {
    return (
      <p className="verdict">
        <span className="badge badge-soon">{words.due(monthYear(next.releaseDate, t.months))}</span>
        {title}
        {(onNow || audio) && <span className="next-why">{[onNow, audio].filter(Boolean).join(' \u00b7 ')}</span>}
      </p>
    )
  }

  return (
    <p className="verdict">
      <span className="badge badge-wait">{words.noDate}</span>
      {title}
      {audio && <span className="next-why">{audio}</span>}
    </p>
  )
}

/** Why the AI tab has no list for a series, and when that may change. */
function MissVerdict({ note }: { note: AiNote }) {
  const { t } = useLanguage()
  if (!note.miss) return null
  const [label, text] = t.verdict.miss(note.miss, note.retryAfter ? dayMonth(note.retryAfter, t.months) : null)
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
