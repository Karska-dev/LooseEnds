import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { Book } from './goodreads'
import { useLanguage } from './language.ts'
import { tintFor, tintIndex } from './tint.ts'
import { QUIET_DARK, QUIET_LIGHT, SIZES } from './shareCard'
import type { CardBook, Format, Shape } from './shareCard'
import { canvasToPng, renderCard } from './drawShareCard'
import { useBackgrounds } from './useBackgrounds'
import { shareText } from './shareText'
import { useYearBook } from './useYearBook'
import { bookKey, booksByMonth, bracket, pickDuel, pickMonth, undoDuel } from './yearBook'
import type { Bracket, MonthState } from './yearBook'

/**
 * "Best of the year": the reader crowns one book by choices of their own.
 * The rules are in yearBook.ts; this file only asks "what now?" and shows
 * the answer (functional core, imperative shell).
 *
 * Nothing is preselected and no rating is shown on a duel: a default would
 * anchor the choice (anchoring bias), and the gut choice is the point.
 */

type View = { kind: 'timeline' } | { kind: 'month'; month: number } | { kind: 'play' }

/** A made-up cover, the same book always the same tint (see tintFor). */
function Cover({ book, className, children }: { book: Book; className: string; children?: ReactNode }) {
  return (
    <span className={`yb-cover ${className}`} style={{ '--tint': tintFor(bookKey(book)) } as CSSProperties} aria-hidden="true">
      {book.title}
      {children}
    </span>
  )
}

const Crown = () => (
  <span className="yb-mark" aria-hidden="true">
    <svg viewBox="0 0 20 20">
      <path d="M3 16 1.5 6l5 4L10 3l3.5 7 5-4L17 16z" />
    </svg>
  </span>
)

export function YearBookTab({
  books,
  year,
  years,
  onYear,
}: {
  books: readonly Book[]
  year: number
  years: number[]
  onYear: (year: number) => void
}) {
  const { t } = useLanguage()
  const y = t.yearBook
  const [decisions, update] = useYearBook(year)
  const [view, setView] = useState<View>({ kind: 'timeline' })
  // Duels answered this visit, for Undo. Only the answers are saved; this
  // stack is just the order they were given in, so it is fine to lose.
  const [given, setGiven] = useState<{ a: Book; b: Book }[]>([])

  const months = useMemo(() => booksByMonth(books, year), [books, year])
  const state = useMemo(() => bracket(months, decisions), [months, decisions])
  const total = months.reduce((sum, list) => sum + list.length, 0)

  if (total === 0) {
    return (
      <div className="yb">
        <YearPicker years={years} year={year} onYear={onYear} />
        <div className="yb-empty">
          <h3>{y.emptyTitle}</h3>
          <p className="note">{y.emptyBody}</p>
        </div>
      </div>
    )
  }

  const chosen = state.months.every((m) => !m.needsPick)
  const finished = chosen && state.next === null

  function changeYear(next: number) {
    setView({ kind: 'timeline' })
    setGiven([])
    onYear(next)
  }

  if (view.kind === 'month') {
    const month = view.month
    const m = state.months[month - 1]!
    return (
      <div className="yb">
        <button type="button" className="ghost yb-back" onClick={() => setView({ kind: 'timeline' })}>
          {y.back(year)}
        </button>
        <header className="yb-head">
          <h3 className="yb-title">{y.monthNames[month - 1]}</h3>
          <span className="note">{y.books(m.books.length)}</span>
        </header>
        <p className="note">{y.pickHint}</p>
        <ul className="yb-grid">
          {m.books.map((book) => (
            <li key={bookKey(book)}>
              <button
                type="button"
                className="yb-choice"
                aria-label={y.choose(book.title)}
                aria-pressed={m.pick === book}
                onClick={() => {
                  update((current) => pickMonth(current, month, book))
                  // An earlier pick changed, so the duels given so far may no longer apply.
                  setGiven([])
                  setView({ kind: 'timeline' })
                }}
              >
                <Cover book={book} className={`yb-big${m.pick === book ? ' is-pick' : ''}`}>
                  {m.pick === book && <Crown />}
                </Cover>
                <span className="yb-author">{book.author}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  if (view.kind === 'play') {
    const next = state.next
    if (next === null) return <Result state={state} year={year} count={total} onBack={() => setView({ kind: 'timeline' })} />
    if (next.kind === 'month') {
      // A month lost its pick (a new export): back to the timeline to choose.
      return <Back onBack={() => setView({ kind: 'timeline' })} year={year} />
    }
    const { a, b } = next
    const label = next.stage === 'year' ? y.stage.year : y.stage[next.stage](next.index)
    const choose = (winner: Book) => {
      update((current) => pickDuel(current, a, b, winner))
      setGiven((list) => [...list, { a, b }])
    }
    return (
      <div className="yb">
        <button type="button" className="ghost yb-back" onClick={() => setView({ kind: 'timeline' })}>
          {y.back(year)}
        </button>
        <header className="yb-head yb-head-duel">
          <div className="yb-head-text">
            <h3 className="yb-title">{label}</h3>
            <span className="note">{y.duelCount(state.duels.answered + 1, state.duels.total)}</span>
          </div>
          <span className="yb-segs" aria-hidden="true">
            {Array.from({ length: state.duels.total }, (_, k) => (
              <i key={k} className={k < state.duels.answered ? 'is-done' : k === state.duels.answered ? 'is-now' : ''} />
            ))}
          </span>
        </header>
        <div className="yb-duel-row">
        <div className="yb-duel">
          {[a, b].map((book, side) => (
            <div key={bookKey(book)} className="yb-side" style={{ gridColumn: side === 0 ? 1 : 3 }}>
              <button type="button" className="yb-choice" aria-label={y.choose(book.title)} onClick={() => choose(book)}>
                <Cover book={book} className="yb-huge" />
                <span className="yb-author">{book.author}</span>
              </button>
            </div>
          ))}
          <span className="yb-or" aria-hidden="true">
            {y.or}
          </span>
        </div>
        <BracketTree state={state} now={next.stage === 'year' ? { stage: 'year', index: 0 } : { stage: next.stage, index: next.index }} />
        </div>
        <div className="yb-foot">
          {given.length > 0 && (
            <button
              type="button"
              className="ghost"
              onClick={() => {
                const last = given[given.length - 1]!
                update((current) => undoDuel(current, last.a, last.b))
                setGiven((list) => list.slice(0, -1))
              }}
            >
              {y.undo}
            </button>
          )}
        </div>
      </div>
    )
  }

  const left = state.months.filter((m) => m.needsPick).length
  // Eleven pixels of each card show, so a busier month is a taller pile. All
  // piles share the busiest one's height: the names below then sit on one line.
  const pileHeight = 120 + Math.max(...state.months.map((m) => m.books.length), 1) * 11
  const choosable = state.months.filter((m) => m.books.length > 1).length
  return (
    <div className="yb">
      <YearPicker years={years} year={year} onYear={changeYear} />
      <h3 className="list-label yb-label">{y.yearLabel(year)}</h3>
      <div className="yb-hintrow">
        <p className="note">{finished ? y.hintDone : chosen ? y.hintChosen : left === choosable ? y.hintStart : y.hintLeft(left)}</p>
        {chosen && (
          <button type="button" className="yb-btn" onClick={() => setView({ kind: 'play' })}>
            {finished ? y.seeResult : y.nextDuel}
          </button>
        )}
      </div>
      <ol className="yb-months" style={{ '--pile-h': `${pileHeight}px` } as CSSProperties}>
        {state.months.map((m, i) => (
          <li key={i}>
            <Month m={m} name={t.months[i]!} fullName={y.monthNames[i]!} muted={chosen} count={y.books(m.books.length)} onOpen={() => setView({ kind: 'month', month: i + 1 })} />
          </li>
        ))}
      </ol>
      <ul className="yb-quarters">
        {[0, 1, 2, 3].map((q) => {
          const settled = state.months.slice(q * 3, q * 3 + 3).filter((m) => !m.needsPick).length
          return (
            <li key={q}>
              <span className="yb-q">{y.stage.quarter(q)}</span>
              <span className={`yb-qstate${settled === 3 ? ' is-ready' : ''}`}>{settled === 3 ? y.ready : y.ofThree(settled)}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** One month's pile: a card per book, overlapped so the height shows how many. */
function Month({
  m,
  name,
  fullName,
  count,
  muted,
  onOpen,
}: {
  m: MonthState
  /** Short on the timeline, where twelve names share one row; the full one is read aloud. */
  name: string
  fullName: string
  count: string
  muted: boolean
  onOpen: () => void
}) {
  const { t } = useLanguage()
  // The favourite sits at the front of the pile; the rest keep date order.
  const ordered = m.pick ? [...m.books.filter((b) => b !== m.pick), m.pick] : m.books
  const body = (
    <>
      <span className="yb-pile" aria-hidden="true">
        {ordered.map((book) => (
          <Cover
            key={bookKey(book)}
            book={book}
            className={book === m.pick && m.books.length > 1 ? 'is-pick' : muted && m.books.length > 1 ? 'is-muted' : ''}
          >
            {book === m.pick && m.books.length > 1 && <Crown />}
          </Cover>
        ))}
      </span>
      <span className="yb-mname">{name}</span>
      <span className="yb-mcount">{count}</span>
    </>
  )
  // One book (or none) has nothing to choose between.
  if (m.books.length < 2) return <div className="yb-month">{body}</div>
  return (
    <button type="button" className="yb-month" aria-label={t.yearBook.monthAria(fullName, m.books.length)} onClick={onOpen}>
      {body}
    </button>
  )
}

function YearPicker({ years, year, onYear }: { years: number[]; year: number; onYear: (year: number) => void }) {
  const { t } = useLanguage()
  if (years.length < 2) return null
  return (
    <div className="yb-years" role="group" aria-label={t.yearBook.yearsLabel}>
      {years.map((value) => (
        <button key={value} type="button" className="ghost" aria-pressed={value === year} onClick={() => onYear(value)}>
          {value}
        </button>
      ))}
    </div>
  )
}

const QUARTER_ROWS = [2, 86, 170, 254] as const

/**
 * The year as a small tree: four quarter boxes, two halves, one winner.
 * A decided box shows a tinted cover, an undecided one is dashed, and the
 * duel being asked right now has a solid primary frame. A picture of the
 * state, drawn from it: nothing here is stored.
 */
function BracketTree({ state, now }: { state: Bracket; now: { stage: 'quarter' | 'half' | 'year'; index: number } }) {
  const { t } = useLanguage()
  const box = (key: string, book: Book | null, x: number, y: number, w: number, h: number, current: boolean) => (
    <rect
      key={key}
      x={x}
      y={y}
      width={w}
      height={h}
      className={`yb-tb${book ? ' is-set' : ''}${current ? ' is-now' : ''}`}
      style={book ? ({ '--tint': tintFor(bookKey(book)) } as CSSProperties) : undefined}
    />
  )
  // Quarter centres sit at row + 32; a half sits midway between its two quarters.
  const mid = (i: number) => (QUARTER_ROWS[i * 2]! + 32 + QUARTER_ROWS[i * 2 + 1]! + 32) / 2
  const win = (QUARTER_ROWS[0] + 32 + QUARTER_ROWS[3] + 32) / 2
  return (
    <svg className="yb-tree" viewBox="0 0 270 330" role="img" aria-label={t.yearBook.treeAlt}>
      {[0, 1, 2, 3].map((i) => (
        <text key={`l${i}`} x="0" y={QUARTER_ROWS[i]! + 36} className="yb-tl">
          {t.yearBook.stage.quarter(i)}
        </text>
      ))}
      <g className="yb-tline" fill="none">
        {[0, 1].map((h) => (
          <path
            key={`h${h}`}
            d={`M72 ${QUARTER_ROWS[h * 2]! + 32} H96 V${mid(h)} M72 ${QUARTER_ROWS[h * 2 + 1]! + 32} H96 V${mid(h)} M96 ${mid(h)} H118`}
          />
        ))}
        <path d={`M164 ${mid(0)} H188 V${win} M164 ${mid(1)} H188 V${win} M188 ${win} H214`} />
      </g>
      {[0, 1, 2, 3].map((i) => box(`q${i}`, state.quarters[i] ?? null, 30, QUARTER_ROWS[i]!, 42, 64, now.stage === 'quarter' && now.index === i))}
      {[0, 1].map((h) => box(`hh${h}`, state.halves[h] ?? null, 118, mid(h) - 32, 46, 64, now.stage === 'half' && now.index === h))}
      {box('w', state.winner ?? null, 214, win - 41, 54, 82, now.stage === 'year')}
      <path d={`M232 ${win + 6} l-5 -14 9 7 5 -12 5 12 9 -7 -5 14z`} className="yb-tcrown" transform="translate(-9 0)" />
    </svg>
  )
}

function Back({ onBack, year }: { onBack: () => void; year: number }) {
  const { t } = useLanguage()
  return (
    <div className="yb">
      <button type="button" className="ghost yb-back" onClick={onBack}>
        {t.yearBook.back(year)}
      </button>
    </div>
  )
}

function Result({ state, year, count, onBack }: { state: Bracket; year: number; count: number; onBack: () => void }) {
  const { t } = useLanguage()
  const winner = state.winner
  return (
    <div className="yb">
      <Back onBack={onBack} year={year} />
      <h3 className="list-label yb-label">{t.yearBook.resultLabel(year)}</h3>
      {winner && <ShareCard state={state} winner={winner} year={year} count={count} />}
      <div className="yb-foot">
        <button type="button" className="ghost" onClick={onBack}>
          {t.yearBook.change}
        </button>
      </div>
    </div>
  )
}

const cardBook = (book: Book): CardBook => ({ title: book.title, author: book.author, tint: tintIndex(bookKey(book)) })

/**
 * The picture to share, drawn here in the browser (nothing is uploaded),
 * with a Download button. Two choices, both with a default: what to show
 * and what shape. The Share button and the backgrounds come later.
 */
function ShareCard({ state, winner, year, count }: { state: Bracket; winner: Book; year: number; count: number }) {
  const { t } = useLanguage()
  const y = t.yearBook
  const host = useRef<HTMLDivElement>(null)
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null)
  const [format, setFormat] = useState<Format>('winner')
  const [shape, setShape] = useState<Shape>('story')
  // The picker starts on plain: no photograph, so no credit to carry.
  const backgrounds = useBackgrounds()
  const [backgroundId, setBackgroundId] = useState<string | null>(null)
  const photo = backgrounds.find((b) => b.id === backgroundId) ?? null
  const credited = backgrounds.filter((b) => b.photographer)

  const quarters = state.quarters.filter((q) => q !== null).length
  const months = state.months.filter((m) => m.books.length > 0).length
  // A path through the year needs more than one quarter to be a path.
  // Each picture is offered only when it has something to show.
  const placed = state.placings.length
  const formats: Format[] = [
    'winner',
    ...(quarters > 1 ? (['quarters'] as const) : []),
    ...(months > 1 ? (['full'] as const) : []),
    ...(placed > 0 ? (['top5'] as const) : []),
    ...(placed > 4 ? (['top10'] as const) : []),
  ]
  const shown: Format = formats.includes(format) ? format : 'winner'

  const label = y.card.label(year)
  const stat =
    shown === 'quarters'
      ? y.card.quartersStat(quarters, months, count)
      : shown === 'full'
        ? y.card.fullStat(months, count)
        : y.card.stat(count, year)

  useEffect(() => {
    let current = true
    const quarterNames = [0, 1, 2, 3].map((i) => t.yearBook.stage.quarter(i))
    renderCard({
      format: shown,
      shape,
      palette: photo?.dark ? QUIET_DARK : QUIET_LIGHT,
      background: photo
        ? {
            src: `/${photo.file}`,
            ...(photo.photographer ? { credit: t.yearBook.card.credit(photo.photographer) } : {}),
          }
        : undefined,
      label,
      stat,
      winner: cardBook(winner),
      quarters: state.quarters.map((q) => (q ? cardBook(q) : null)),
      halves: state.halves.map((h) => (h ? cardBook(h) : null)),
      quarterNames,
      months: state.months.map((m) => (m.pick ? cardBook(m.pick) : null)),
      monthLetters: t.months.map((m) => [...m][0]!.toLocaleUpperCase()),
      placings: state.placings.map((p) => ({
        book: cardBook(p.book),
        label:
          p.tier === 'runnerUp'
            ? t.yearBook.card.runnerUp
            : p.tier === 'quarter'
              ? t.yearBook.card.quarterPick(t.yearBook.stage.quarter(p.at - 1))
              : t.yearBook.monthNames[p.at - 1]!,
      })),
    })
      .then((drawn) => {
        // A newer draw (another shape, another language) may have started.
        if (!current) return
        drawn.setAttribute('role', 'img')
        drawn.setAttribute('aria-label', t.yearBook.pictureAlt(winner.title))
        host.current?.replaceChildren(drawn)
        setCanvas(drawn)
      })
      .catch(() => setCanvas(null))
    return () => {
      current = false
    }
  }, [state, winner, shown, shape, photo, label, stat, t])

  async function download() {
    if (!canvas) return
    const url = URL.createObjectURL(await canvasToPng(canvas))
    const link = document.createElement('a')
    link.href = url
    link.download = `best-of-${year}-${shown}-${shape}${photo ? `-${photo.id}` : ''}.png`
    link.click()
    URL.revokeObjectURL(url)
  }

  async function share() {
    if (!canvas) return
    const blob = await canvasToPng(canvas)
    const file = new File([blob], `best-of-${year}.png`, { type: 'image/png' })
    const text = shareText(
      y.card.caption(winner.title, winner.author, year),
      photo?.photographer ? y.card.credit(photo.photographer) : undefined,
    )
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], text })
        return
      } catch (error) {
        // Closing the share sheet is an answer, not a failure.
        if (error instanceof DOMException && error.name === 'AbortError') return
      }
    }
    await download()
  }

  const { width, height } = SIZES[shape]
  const shapeIcon = { story: [10, 17], post: [14, 17], square: [15, 15] } as const
  return (
    <div className="yb-share">
      <div className="yb-share-pic">
        <div className="yb-card-img" ref={host} style={{ aspectRatio: `${width} / ${height}` }} />
      </div>
      <div className="yb-share-controls">
        <div>
          <p className="yb-lab">{y.format.label}</p>
          <div className="yb-chips" role="group" aria-label={y.format.label}>
            {formats.map((f) => (
              <button key={f} type="button" className="yb-chip" aria-pressed={f === shown} onClick={() => setFormat(f)}>
                {y.format[f]}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="yb-lab">{y.shape.label}</p>
          <div className="yb-chips" role="group" aria-label={y.shape.label}>
            {(['story', 'post', 'square'] as const).map((s) => (
              <button key={s} type="button" className="yb-chip yb-shape" aria-pressed={s === shape} onClick={() => setShape(s)}>
                <svg width={shapeIcon[s][0]} height={shapeIcon[s][1]} viewBox={`0 0 ${shapeIcon[s][0]} ${shapeIcon[s][1]}`} aria-hidden="true">
                  <rect x=".5" y=".5" width={shapeIcon[s][0] - 1} height={shapeIcon[s][1] - 1} fill="none" stroke="currentColor" />
                </svg>
                {y.shape[s]}
              </button>
            ))}
          </div>
        </div>
        {backgrounds.length > 0 && (
          <div>
            <p className="yb-lab">{y.background.label}</p>
            <div className="yb-bgs" role="group" aria-label={y.background.label}>
              <button
                type="button"
                className="yb-bg yb-bg-plain"
                aria-pressed={photo === null}
                aria-label={y.background.plain}
                onClick={() => setBackgroundId(null)}
              >
                <span>{y.background.plain}</span>
              </button>
              {backgrounds.map((b, i) => (
                <button
                  key={b.id}
                  type="button"
                  className="yb-bg"
                  aria-pressed={b.id === photo?.id}
                  aria-label={y.background.option(i + 1)}
                  onClick={() => setBackgroundId(b.id)}
                >
                  <img src={`/${b.file}`} alt="" loading="lazy" width="54" height="96" />
                </button>
              ))}
            </div>
            {photo?.photographer && (
              <p className="yb-credit">
                {y.card.credit(photo.photographer)}. {y.background.creditNote}
              </p>
            )}
            {credited.length > 0 && (
              <details className="yb-credits">
                <summary>{y.credits.title}</summary>
                <p>{y.credits.intro}</p>
                <ul>
                  {credited.map((b) => (
                    <li key={b.id}>
                      <img src={`/${b.file}`} alt="" loading="lazy" width="18" height="32" />
                      {b.photographer}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
        <div className="yb-actions">
          <button type="button" className="yb-btn" disabled={!canvas} onClick={share}>
            {y.share}
          </button>
          <button type="button" className="ghost" disabled={!canvas} onClick={download}>
            {y.download}
          </button>
        </div>
      </div>
    </div>
  )
}
