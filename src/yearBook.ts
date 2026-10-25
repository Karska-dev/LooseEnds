/**
 * Best of the year: the reader crowns one book by a small tournament.
 * Months pick their best from a list; above that it is duels, always two
 * books, in calendar order: Jan vs Feb, the winner vs Mar (a quarter), then
 * quarter vs quarter (a half), then half vs half (the year).
 *
 * Everything here is pure. Reading and writing storage lives in
 * useYearBook.ts. Nothing here ever leaves the browser.
 *
 * Functional core, imperative shell: the rules sit apart from React and
 * storage, so the edge cases (empty months, one book, 31 Dec) are tested
 * with plain arrays.
 */

import type { Book } from './goodreads'

export const STORAGE_KEY = 'looseends:yearbook'

/**
 * What the reader decided, and nothing else.
 *
 * Derive, don't store: the bracket (who meets whom, who is skipped, who won)
 * is worked out again from these answers each time. A saved copy of it could
 * disagree with the answers after an undo, an edit or a new export; a
 * recomputed one cannot.
 */
export interface YearDecisions {
  /** Month number "1".."12" → key of the book picked from that month. */
  months: Record<string, string>
  /** `pairKey` of two books → key of the one that won the duel. */
  duels: Record<string, string>
}

export const NO_DECISIONS: YearDecisions = { months: {}, duels: {} }

/** Saved decisions for every year the reader has played, by year ("2026"). */
export type YearBook = Record<string, YearDecisions>

const norm = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * ISBN13, else title + author: stable across a new export, which a row
 * number or an index would not be.
 */
export function bookKey(book: Book): string {
  return book.isbn13 ? `isbn:${book.isbn13}` : `t:${norm(book.title)}|${norm(book.author)}`
}

/**
 * A duel is remembered by the two books in it, not by its place in the
 * bracket, and the order does not matter. So when an early pick changes,
 * a later duel between the same two books keeps its answer and any new
 * pairing is simply asked.
 */
export function pairKey(a: Book, b: Book): string {
  return JSON.stringify([bookKey(a), bookKey(b)].sort())
}

/** Month 1..12 of a "YYYY-MM-DD" date in the given year, else null. */
function monthIn(date: string | null, year: number): number | null {
  // Text, not Date: a Date is a moment, and the time zone could move
  // 31 Dec into the next year.
  const match = date?.match(/^(\d{4})-(\d{2})-\d{2}$/)
  if (!match || Number(match[1]) !== year) return null
  const month = Number(match[2])
  return month >= 1 && month <= 12 ? month : null
}

/** Years with at least one finished, dated book, newest first. */
export function readYears(books: readonly Book[]): number[] {
  const years = new Set<number>()
  for (const book of books) {
    const year = book.shelf === 'read' ? Number(book.dateRead?.slice(0, 4)) : NaN
    if (Number.isInteger(year) && monthIn(book.dateRead, year) !== null) years.add(year)
  }
  return [...years].sort((a, b) => b - a)
}

/**
 * The candidates: books on the read shelf with a Date Read in the year,
 * twelve lists (January is index 0). Did-not-finish books are on their own
 * shelf, so they never compete. A book is counted once: if the same book
 * appears twice, the earlier date stands.
 */
export function booksByMonth(books: readonly Book[], year: number): Book[][] {
  const months: Book[][] = Array.from({ length: 12 }, () => [])
  const dated = books
    .filter((book) => book.shelf === 'read' && monthIn(book.dateRead, year) !== null)
    .sort((a, b) => (a.dateRead! < b.dateRead! ? -1 : a.dateRead! > b.dateRead! ? 1 : a.title < b.title ? -1 : 1))
  const seen = new Set<string>()
  for (const book of dated) {
    const key = bookKey(book)
    if (seen.has(key)) continue
    seen.add(key)
    months[monthIn(book.dateRead, year)! - 1]!.push(book)
  }
  return months
}

export type Stage = 'quarter' | 'half' | 'year'

/** The next thing to ask the reader: always one of these two screens. */
export type Question =
  | { kind: 'month'; month: number; books: Book[] }
  | {
      kind: 'duel'
      stage: Stage
      /** Quarter 0..3, half 0..1, year 0. */
      index: number
      /** Calendar order: `a` is the earlier month, quarter or half. */
      a: Book
      b: Book
    }

export interface MonthState {
  books: Book[]
  /** The month's best: chosen, or the only book. Null for an empty month or one still to choose. */
  pick: Book | null
  /** More than one book and no valid choice yet. */
  needsPick: boolean
}

export interface Bracket {
  months: MonthState[]
  /** Q1..Q4. Null while undecided, or when the whole quarter was empty. */
  quarters: (Book | null)[]
  /** Jan–Jun, Jul–Dec. */
  halves: (Book | null)[]
  /** Null while undecided; also null when the year has no books at all. */
  winner: Book | null
  /** The next question, or null when everything is decided. */
  next: Question | null
}

/** Not decided yet, as against null, which means nobody is there. */
const PENDING = Symbol('pending')
type Slot = Book | null | typeof PENDING

/**
 * Plays the bracket from the books and the reader's answers. The one place
 * that knows the rules; the screens only ask `next`.
 *
 * Empty months and quarters are skipped, and a lone book wins by default:
 * no screen ever asks for a choice between nothing and something.
 * Month picks are asked before any duel.
 */
export function bracket(months: readonly (readonly Book[])[], decisions: YearDecisions): Bracket {
  const monthQuestions: Question[] = []
  const duelQuestions: Question[] = []

  function meet(a: Slot, b: Slot, stage: Stage, index: number): Slot {
    if (a === PENDING || b === PENDING) return PENDING
    if (!a) return b
    if (!b) return a
    const saved = decisions.duels[pairKey(a, b)]
    if (saved === bookKey(a)) return a
    if (saved === bookKey(b)) return b
    duelQuestions.push({ kind: 'duel', stage, index, a, b })
    return PENDING
  }

  const states: MonthState[] = months.map((list, i) => {
    const books = [...list]
    const month = i + 1
    if (books.length <= 1) return { books, pick: books[0] ?? null, needsPick: false }
    // A saved pick that is no longer in the month (a new export) is no pick.
    const pick = books.find((book) => bookKey(book) === decisions.months[String(month)]) ?? null
    if (!pick) monthQuestions.push({ kind: 'month', month, books })
    return { books, pick, needsPick: !pick }
  })
  const slots: Slot[] = states.map((s) => (s.needsPick ? PENDING : s.pick))

  // Winner stays on: month 1 vs month 2, the winner vs month 3.
  const quarterSlots: Slot[] = [0, 1, 2, 3].map((q) => {
    const [m1, m2, m3] = slots.slice(q * 3, q * 3 + 3) as [Slot, Slot, Slot]
    return meet(meet(m1, m2, 'quarter', q), m3, 'quarter', q)
  })
  const halfSlots: Slot[] = [0, 1].map((h) =>
    meet(quarterSlots[h * 2]!, quarterSlots[h * 2 + 1]!, 'half', h),
  )
  const winnerSlot = meet(halfSlots[0]!, halfSlots[1]!, 'year', 0)

  const known = (slot: Slot) => (slot === PENDING ? null : slot)
  return {
    months: states,
    quarters: quarterSlots.map(known),
    halves: halfSlots.map(known),
    winner: known(winnerSlot),
    next: monthQuestions[0] ?? duelQuestions[0] ?? null,
  }
}

// --- the reader's answers -------------------------------------------------

export function pickMonth(decisions: YearDecisions, month: number, book: Book): YearDecisions {
  return { ...decisions, months: { ...decisions.months, [String(month)]: bookKey(book) } }
}

export function pickDuel(decisions: YearDecisions, a: Book, b: Book, winner: Book): YearDecisions {
  return { ...decisions, duels: { ...decisions.duels, [pairKey(a, b)]: bookKey(winner) } }
}

export function hasDecisions(decisions: YearDecisions): boolean {
  return Object.keys(decisions.months).length > 0 || Object.keys(decisions.duels).length > 0
}

// --- storage format -------------------------------------------------------

function stringMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key !== '' && typeof entry === 'string' && entry !== '') out[key] = entry
  }
  return out
}

/** Whatever is in storage, made safe: bad JSON or a bad shape is simply no decisions. */
export function parseYearBook(raw: string | null): YearBook {
  if (!raw) return {}
  try {
    const data: unknown = JSON.parse(raw)
    if (typeof data !== 'object' || data === null) return {}
    const years = (data as Record<string, unknown>).years
    if (typeof years !== 'object' || years === null || Array.isArray(years)) return {}
    const out: YearBook = {}
    for (const [year, value] of Object.entries(years)) {
      if (!/^\d{4}$/.test(year) || typeof value !== 'object' || value === null) continue
      const record = value as Record<string, unknown>
      const months = stringMap(record.months)
      // Only months 1..12 mean anything.
      for (const month of Object.keys(months)) {
        if (!/^(?:[1-9]|1[0-2])$/.test(month)) delete months[month]
      }
      const decisions = { months, duels: stringMap(record.duels) }
      if (hasDecisions(decisions)) out[year] = decisions
    }
    return out
  } catch {
    return {}
  }
}

export function serializeYearBook(yearBook: YearBook): string {
  return JSON.stringify({ v: 1, years: yearBook })
}

export function decisionsFor(yearBook: YearBook, year: number): YearDecisions {
  return yearBook[String(year)] ?? NO_DECISIONS
}

export function withDecisions(yearBook: YearBook, year: number, decisions: YearDecisions): YearBook {
  const next = { ...yearBook }
  if (hasDecisions(decisions)) next[String(year)] = decisions
  else delete next[String(year)]
  return next
}
