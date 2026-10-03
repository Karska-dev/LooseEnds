/**
 * The experimental AI lookup: find a series' books on the open web.
 *
 *   search  — one web search for the series, page text included
 *   extract — a model reads those pages and drafts the book list
 *   verify  — plain code keeps only what the pages actually say
 *
 * The model is never trusted on its own. It is told to use only the pages
 * it is given, and then every title, date, audiobook detail and reading-
 * order note is checked against the page text here. What a page does not
 * say is dropped, however plausible it sounds.
 *
 * Shared by the benchmark script today, and by the Worker and the Vite
 * middleware later, so the model call and the search call are passed in:
 * Workers AI in production, Ollama on a laptop, a stub in tests.
 */

import type { Edition, SeriesQuery, SeriesResult, Volume } from './hardcover.ts'

/** A fetched page: where it is and what it says. */
export interface Page {
  url: string
  title: string
  /**
   * What the page says: the search's own excerpt of it, then the cleaned
   * page text when the search could fetch it. Verification runs against all
   * of this.
   */
  text: string
  /** Just the search's excerpt. Many sites refuse to be fetched; this still comes. */
  snippet?: string
  /** How relevant the search thought this result, 0 to 1, when it says. */
  score?: number
}

/** What the model is asked to return. Every field is checked afterwards. */
export interface DraftBook {
  title: string
  /** Number in the series as the page gives it; 1.5 for a novella. */
  position: number | null
  /** "YYYY-MM-DD", "YYYY-MM" or "YYYY", or null when the page has none. */
  releaseDate: string | null
  /** Which page it came from: "P1", "P2", … as labelled in the prompt. */
  source: string
  audiobook: { year: string | null; publisher: string | null } | null
}

export interface Draft {
  seriesName: string | null
  readingOrder: { note: string; source: string } | null
  books: DraftBook[]
}

/** Audiobook facts a page gave. Both parts are optional. */
export interface AudioInfo {
  year: string | null
  publisher: string | null
}

export interface VerifiedBook {
  title: string
  position: number
  /** "pages" when a page numbers the book; "model" when only the model did. */
  positionFrom: 'pages' | 'model'
  releaseDate: string | null
  /** The page the title was found on. */
  url: string
  /** False when the model's date was not on the page and was dropped. */
  dateVerified: boolean
  /** The title was not on the page the model cited, but was on another one. */
  resourced: boolean
  hasAudio: boolean
  audio: AudioInfo | null
}

export interface AiEdition extends Edition {
  /** Year and publisher of the audiobook, when a fetched page gave them. */
  audio?: AudioInfo | null
  /**
   * No release date was found, but a later book in the series has a
   * confirmed past date, so this one must be out. Only the AI lookup sets it.
   */
  releasedInferred?: boolean
}

export interface AiVolume extends Volume {
  editions: AiEdition[]
  /** Where it was found, and whether a page or only the model gave its number. */
  evidence: { url: string; dateVerified: boolean; positionFrom: 'pages' | 'model' }
}

export interface AiSeriesResult extends SeriesResult {
  source: 'ai'
  /** The day this was looked up, "YYYY-MM-DD". */
  checkedAt: string
  volumes: AiVolume[]
  readingOrder?: { note: string; url: string } | null
}

/** What a run cost and why books were dropped; for logs and the benchmark. */
export interface AiReport {
  /** What was read. `full` is false for a source read only as the search's excerpt. */
  pages: { url: string; title: string; chars: number; full: boolean }[]
  drafted: number
  kept: number
  dropped: { title: string; reason: string }[]
  datesDropped: number
  /** Kept books no page numbered: their place is the model's word alone. */
  numberedByModel: number
  resourced: number
  searches: number
  modelCalls: number
  ms: { search: number; model: number }
}

export type SearchFn = (query: string) => Promise<Page[]>

export interface ModelRequest {
  system: string
  user: string
  /** JSON schema the reply must follow. */
  schema: unknown
}

/** Returns the model's reply as text; it is parsed and checked here. */
export type ModelFn = (request: ModelRequest) => Promise<string>

/** Pages the model reads in full. More cost more and rarely add books. */
const MAX_PAGES = 4
/** Characters of each full page the model sees. */
const PAGE_BUDGET = 5000
/** How far after a title its date or audiobook detail may sit. */
const NEAR = 500
/** Fewer verified books than this is not a series we can stand behind. */
const MIN_BOOKS = 2

/** Never read these: Goodreads' terms forbid it, and shop pages are noise. */
export const BLOCKED_HOSTS = ['goodreads.com', 'amazon.']

export const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    seriesName: { type: ['string', 'null'] },
    readingOrder: {
      type: ['object', 'null'],
      properties: { note: { type: 'string' }, source: { type: 'string' } },
      required: ['note', 'source'],
    },
    books: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          position: { type: ['number', 'null'] },
          releaseDate: { type: ['string', 'null'] },
          source: { type: 'string' },
          audiobook: {
            type: ['object', 'null'],
            properties: {
              year: { type: ['string', 'null'] },
              publisher: { type: ['string', 'null'] },
            },
            required: ['year', 'publisher'],
          },
        },
        required: ['title', 'position', 'releaseDate', 'source', 'audiobook'],
      },
    },
  },
  required: ['seriesName', 'readingOrder', 'books'],
}

export const SYSTEM_PROMPT = `You list the books of ONE book series, using ONLY the web pages you are given.

Rules:
- Use nothing you remember. If the pages do not say it, leave it out or use null.
- List only the books the pages place in the series you are asked about. Pages often list several series by the same author, or several series set in the same world, in one "reading order". Leave out every book a page gives to another series, even a closely related one.
- title: the book's title exactly as the page writes it, without the series name or number.
- position: the book's number in THIS series as a page writes it (Book 3, #3, "3."). Novellas and short stories between books may be 1.5, 2.5 and so on. Never renumber books yourself, and never use a number that counts books across several series. If no page numbers the book but a page lists this series alone in reading order, count along that list. Use null if you cannot tell.
- releaseDate: the first publication date a page gives for that book, as YYYY-MM-DD, YYYY-MM or YYYY. A year in brackets after a title is its publication year. Use null if no page gives one. Never guess.
- source: the label of the page the book came from: P1, P2, and so on.
- audiobook: null unless a page says this book has an audiobook (for example "audiobook", "Audible", "narrated by"). If it does, give the audiobook's year and publisher when the page states them, otherwise null for each.
- readingOrder: null unless a page states the order the author or publisher recommends reading this series in. If it does, give that advice in one short sentence and the page's label.
- Include books that are announced but not yet published, if the pages name them.
- Do not include box sets, omnibus editions or translations.
- Some pages are only a short excerpt. Use them like any other page.

Reply with JSON only.`

/**
 * Lower case, letters and digits only, single spaces. One thing survives:
 * the point in "8.5", written "8_5", because a novella's place in a series
 * is a number the pages give and must not fall apart into "8 5".
 */
export function normalise(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/(?<![\d.])(\d{1,3})\.(\d)(?!\d|\.\d)/g, '$1_$2')
    .replace(/[^a-z0-9_]+/g, ' ')
    .trim()
}

function isBlocked(url: string): boolean {
  return BLOCKED_HOSTS.some((host) => url.toLowerCase().includes(host))
}

/** Distinct years a page mentions: a rough sign that it gives release dates. */
function yearsOn(text: string): number {
  return new Set(text.match(/\b(?:19|20)\d\d\b/g) ?? []).size
}

/**
 * What the model reads: every source the search returned, most of them as
 * the search's short excerpt, and the first few as the page itself.
 *
 * The excerpts matter more than their size suggests. Sites that keep tidy
 * numbered, dated lists — the bibliography sites — mostly refuse to be
 * fetched, but the search still quotes the line that matched, and that line
 * is often the list itself.
 *
 * Full pages keep the search's order, except that an author's or
 * publisher's page often lists the books with no dates at all; so if the
 * first few carry none, the last full place goes to the best-ranked page
 * that does.
 */
export function choosePages(found: Page[], limit = MAX_PAGES): Page[] {
  const usable = found.filter((page) => !isBlocked(page.url) && page.text.trim().length > 0)
  const hasBody = (page: Page) => page.text.length > (page.snippet ?? '').length
  const full = usable.filter(hasBody)
  const chosen = new Set(full.slice(0, limit))
  const DATED = 4
  if (full.length > limit && ![...chosen].some((page) => yearsOn(page.text) >= DATED)) {
    const dated = full.slice(limit).find((page) => yearsOn(page.text) >= DATED)
    if (dated) {
      chosen.delete(full[limit - 1])
      chosen.add(dated)
    }
  }
  return usable.flatMap((page) => {
    if (chosen.has(page)) return [page]
    // Everything else is read as its excerpt only.
    const snippet = (page.snippet ?? '').trim()
    return snippet ? [{ ...page, text: snippet }] : []
  })
}

export function searchQueryFor(query: SeriesQuery): string {
  return `"${query.name}" ${query.author ?? ''} book series in order`.replace(/\s+/g, ' ').trim()
}

/**
 * A second way to ask, for when the first comes back with pages about
 * something else. An unusual word in a series name can pull the search
 * towards dictionaries or a brand; leading with the author keeps it on books.
 */
export function fallbackQueryFor(query: SeriesQuery): string {
  return `${query.author ?? ''} ${query.name} series books in order`.replace(/\s+/g, ' ').trim()
}

/**
 * Said when neither search came back with anything about the series. It is
 * usually the search having a bad moment, not the series being unknown —
 * the same question often works an hour later — so the cache keeps this
 * answer for a day, not for weeks.
 */
export const NOTHING_RELEVANT = 'the search found nothing about this series'

/**
 * The one miss that says something about the series itself: pages about it
 * were found and read, and too little of what the model listed was on them.
 * Every other miss is the search or the model having a bad moment.
 */
export const TOO_FEW_BOOKS = 'too few verified books'

/** Below this, the search itself rates its best result as beside the point. */
const MIN_SCORE = 0.3

/**
 * Whether the search understood the question: one source names the series,
 * and the search does not rate everything it found as irrelevant. "Trilogy"
 * and the like are left out of the name, since pages say "series" as often.
 */
export function mentionsSeries(pages: Page[], seriesName: string): boolean {
  const name = normalise(seriesName)
    .replace(/^the /, '')
    .replace(/ (?:series|trilogy|duology|duet|saga|books|novels)$/, '')
  if (name.length === 0 || !pages.some((page) => normalise(`${page.title} ${page.text}`).includes(name))) return false
  const scores = pages.flatMap((page) => (typeof page.score === 'number' ? [page.score] : []))
  return scores.length === 0 || Math.max(...scores) >= MIN_SCORE
}

/**
 * The part of a page the model reads. A book list often sits below menus and
 * a blurb, so a long page is cut around the first mention of the series
 * rather than from the top.
 */
export function excerpt(text: string, seriesName: string, budget = PAGE_BUDGET): string {
  if (text.length <= budget) return text
  const at = text.toLowerCase().indexOf(seriesName.toLowerCase())
  const start = at > 400 ? at - 400 : 0
  return text.slice(start, start + budget)
}

export function buildUserPrompt(query: SeriesQuery, pages: Page[]): string {
  const blocks = pages.map(
    (page, index) =>
      `=== P${index + 1} — ${page.title} — ${page.url} ===\n${excerpt(page.text, query.name)}`,
  )
  return (
    `Series: ${query.name}\n` +
    (query.author ? `Author: ${query.author}\n` : '') +
    `\nPages:\n\n${blocks.join('\n\n')}`
  )
}

/** Models wrap JSON in prose or code fences often enough to plan for it. */
export function parseDraft(reply: string): Draft | null {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const value = JSON.parse(reply.slice(start, end + 1)) as Partial<Draft>
    if (!Array.isArray(value.books)) return null
    return {
      seriesName: typeof value.seriesName === 'string' ? value.seriesName : null,
      readingOrder:
        value.readingOrder && typeof value.readingOrder.note === 'string'
          ? { note: value.readingOrder.note, source: String(value.readingOrder.source ?? '') }
          : null,
      books: value.books.filter(
        (book): book is DraftBook => typeof book === 'object' && book !== null && typeof book.title === 'string',
      ),
    }
  } catch {
    return null
  }
}

function pageIndex(label: string): number {
  const match = /(\d+)/.exec(label)
  return match ? Number(match[1]) - 1 : -1
}

/** Every place the normalised title starts in the normalised page text. */
function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = []
  if (!needle) return found
  let from = 0
  while (from <= haystack.length) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) break
    // Whole words only: "Bride" must not match inside "Bridesmaid".
    const before = at === 0 || haystack[at - 1] === ' '
    const after = at + needle.length === haystack.length || haystack[at + needle.length] === ' '
    if (before && after) found.push(at)
    from = at + 1
  }
  return found
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]

/**
 * How much of a date the text near a title supports. A page is full of
 * years, so the year must be near the title; the month and day are kept only
 * if the page writes them next to that year. Returns the date at the
 * precision the page backs, or null when even the year is missing.
 */
export function supportedDate(date: string, windows: string[]): string | null {
  const match = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(date.trim())
  if (!match) return null
  const [, year, month, day] = match
  const near = windows.filter((window) => occurrences(window, year).length > 0)
  if (near.length === 0) return null
  if (!month) return year

  const monthIndex = Number(month) - 1
  if (monthIndex < 0 || monthIndex > 11) return year
  // Punctuation is already spaces here, so "Dec. 6th, 2024", "6 December
  // 2024", "2024-12-06" and "12/06/2024" all reduce to a few plain shapes.
  // The full name or its usual short form, never a longer word: "nov" must
  // not be read out of "novella".
  const full = MONTHS[monthIndex]
  const name = `(?:${full}|${full.slice(0, 3)}${monthIndex === 8 ? '|sept' : ''})`
  const m = `0?${Number(month)}`
  const d = day ? `0?${Number(day)}(?:st|nd|rd|th)?` : ''
  const any = (patterns: string[]) =>
    near.some((window) => patterns.some((pattern) => new RegExp(`(?:^| )${pattern}(?: |$)`).test(window)))

  if (
    day &&
    any([
      `${name} ${d} ${year}`,
      `${d} ${name} ${year}`,
      `${year} ${m} ${d}`,
      `${m} ${d} ${year}`,
      `${d} ${m} ${year}`,
    ])
  ) {
    return `${year}-${month}-${day}`
  }
  if (any([`${name} ${year}`, `${name} [0-9]{1,2}(?:st|nd|rd|th)? ${year}`, `[0-9]{1,2}(?:st|nd|rd|th)? ${name} ${year}`, `${year} ${month}`])) {
    return `${year}-${month}`
  }
  return year
}

/**
 * The stretch of page that belongs to one book: from its title to the next
 * book's title, or NEAR characters, whichever comes first. A series page is
 * usually one line per book, so anything wider would let a book borrow its
 * neighbour's date. Text before the title is not used for the same reason:
 * between two titles it could belong to either.
 */
function segmentsFor(text: string, needle: string, own: number[], otherStarts: number[]): string[] {
  return own.map((at) => {
    const limit = at + needle.length + NEAR
    const next = otherStarts.find((start) => start >= at + needle.length)
    return text.slice(at, next === undefined ? limit : Math.min(next, limit))
  })
}

/** "3", "12" or "8_5" (how normalise writes 8.5): a place in a series, never a year. */
function positionToken(token: string | undefined): number | null {
  if (!token || !/^\d{1,3}(?:_\d)?$/.test(token)) return null
  return Number(token.replace('_', '.'))
}

const isYear = (token: string | undefined) => Boolean(token) && /^(?:19|20)\d\d$/.test(token as string)

/** Words that may stand between a title and its number: "(Book #3 of the …". */
const FILLER = new Set(['book', 'bk', 'vol', 'volume', 'part', 'no', 'number', 'of', 'in', 'the', 'a', 'series', 'novella', 'novel'])

interface PageNumber {
  number: number
  /** The page ties the number to this series by name: "(Royal Elite #2)". */
  labelled: boolean
}

/**
 * The number a page gives each title, read off the page rather than taken
 * from the model.
 *
 * Strongest is a number the page ties to the series by name — "(Royal Elite
 * #2)", "Zodiac Academy 4: Shadow Princess", "Book #4 of Zodiac Academy" —
 * because an author's own site may number every book she has written 1 to
 * 60 and still say which is Royal Elite #2.
 *
 * Failing that, pages write a bare number one of two ways — "2. Savage
 * Bonds" or "Savage Bonds #2" — and a number sitting between two titles
 * could belong to either, so each page is read both ways and the reading
 * that numbers more of its titles wins.
 */
function numbersOnPage(text: string, where: Map<string, number[]>, seriesName: string): Map<string, PageNumber> {
  const seriesTokens = new Set(seriesName.split(' ').filter(Boolean))
  const all = [...where.entries()]
    .flatMap(([needle, places]) => places.map((at) => ({ needle, at })))
    .sort((a, b) => a.at - b.at)
  // A first book named after its series ("Bride", "The Wolf King") turns up
  // wherever the series is mentioned. Only where a number stands right
  // before it is it the book; everywhere else it is the series' name, and
  // must not cut another title's text short or pick up that title's number.
  const numberedBefore = (at: number) => positionToken(text.slice(Math.max(0, at - 12), at).trim().split(' ').pop()) !== null
  const starts = all.filter(({ needle, at }) => needle !== seriesName || numberedBefore(at))

  // The series name is looked for outside the titles themselves: in a series
  // called "Villain", "Kiss the Villain 34." is not "Villain #34".
  const pieces: string[] = []
  let upTo = 0
  for (const { needle, at } of starts) {
    if (at < upTo) continue
    pieces.push(text.slice(upTo, at), '~'.repeat(needle.length))
    upTo = at + needle.length
  }
  pieces.push(text.slice(upTo))
  const masked = pieces.join('')

  // "zodiac academy 4", "the bonds that tie book 1", and "4 of zodiac academy".
  const series = seriesName.replace(/^the /, '')
  const N = '(\\d{1,3}(?:_\\d)?)'
  const fill = '(?:(?:the|a|book|bk|vol|volume|part|no|number|series|novella|novel) )*'
  const labelledBefore = series ? new RegExp(`(?:^| )${series} ${fill}${N}$`) : null
  const labelledAfter = series
    ? new RegExp(`^${fill}(?:${series} ${fill}${N}|${N} (?:of|in) (?:the )?${series})(?: |$)`)
    : null

  // Each kind of number is read both ways — written before its title, or
  // after it — because a number between two titles could belong to either.
  const reading = () => ({ numbers: new Map<string, number>(), first: Infinity })
  const namedBefore = reading()
  const namedAfter = reading()
  const bareBefore = reading()
  const bareAfter = reading()
  const note = (into: { numbers: Map<string, number>; first: number }, needle: string, at: number, token: string | undefined) => {
    const number = positionToken(token)
    if (number === null || into.numbers.has(needle)) return
    into.numbers.set(needle, number)
    into.first = Math.min(into.first, at)
  }
  for (const [index, { needle, at }] of starts.entries()) {
    const end = at + needle.length
    const next = starts.slice(index + 1).find((other) => other.at >= end)
    const lead = text.slice(Math.max(0, at - 80), at).trim()
    const tailText = text.slice(end, next ? Math.min(next.at, end + 120) : end + 120).trim()

    note(namedBefore, needle, at, labelledBefore?.exec(masked.slice(Math.max(0, at - 80), at).trim())?.[1])
    const afterMatch = labelledAfter?.exec(masked.slice(end, next ? Math.min(next.at, end + 120) : end + 120).trim())
    note(namedAfter, needle, at, afterMatch?.[1] ?? afterMatch?.[2])

    const words = lead.split(' ')
    note(bareBefore, needle, at, words[words.length - 1])
    if (needle !== seriesName && !bareAfter.numbers.has(needle)) {
      const tail = tailText.split(' ').filter(Boolean)
      let sawYear = false
      for (const [place, token] of tail.entries()) {
        if (isYear(token)) {
          sawYear = true
          continue
        }
        if (FILLER.has(token) || seriesTokens.has(token)) continue
        // After a year, a number right before the next title is that title's
        // own: "My Dark Romeo (2023) · 2 My Dark Desire".
        const belongsToNext = Boolean(next) && sawYear && place === tail.length - 1
        if (!belongsToNext) note(bareAfter, needle, at, token)
        break
      }
    }
  }
  // Of two readings: the one that numbers more titles; if they tie, the one
  // that starts numbering earlier on the page — a list's first title has
  // its number on the side the page really uses.
  const better = (before: ReturnType<typeof reading>, after: ReturnType<typeof reading>) =>
    after.numbers.size !== before.numbers.size
      ? after.numbers.size > before.numbers.size
        ? after
        : before
      : after.first < before.first
        ? after
        : before

  const result = new Map<string, PageNumber>()
  for (const [needle, number] of better(bareBefore, bareAfter).numbers) result.set(needle, { number, labelled: false })
  for (const [needle, number] of better(namedBefore, namedAfter).numbers) result.set(needle, { number, labelled: true })
  return result
}

/** The most common value; on a tie, the preferred one if it is among them, else the first seen. */
function majority<T>(values: T[], preferred?: T | null): T | null {
  if (values.length === 0) return null
  const counts = new Map<T, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  const top = Math.max(...counts.values())
  const leaders = [...counts.entries()].filter(([, count]) => count === top).map(([value]) => value)
  return preferred !== undefined && preferred !== null && leaders.includes(preferred) ? preferred : leaders[0]
}

/**
 * Keeps what the pages say and drops the rest. Pure: pages and a draft in,
 * verified books out, with a reason for everything that was dropped.
 *
 * The model decides only which titles to put forward. Whether a title is on
 * a page, which number the pages give it, and which date sits next to it are
 * all read from the page text here.
 */
export function verifyAgainstPages(
  draft: Draft,
  pages: Page[],
  seriesName = '',
): {
  books: VerifiedBook[]
  dropped: { title: string; reason: string }[]
  /** Kept books whose date the page did not back, so it was removed. */
  datesDropped: number
  readingOrder: { note: string; url: string } | null
} {
  const texts = pages.map((page) => normalise(page.text))
  const dropped: { title: string; reason: string }[] = []
  let datesDropped = 0

  // One entry per distinct title, in the order the model gave them.
  const drafted = new Map<string, DraftBook>()
  for (const book of draft.books) {
    const needle = normalise(book.title)
    if (!needle) dropped.push({ title: book.title, reason: 'empty title' })
    else if (!drafted.has(needle)) drafted.set(needle, book)
  }
  const needles = [...drafted.keys()]
  // Where each title stands on each page, found once: everything below asks.
  const where = texts.map((text) => new Map(needles.map((needle) => [needle, occurrences(text, needle)])))
  const starts = where.map((places) =>
    [...places.entries()].flatMap(([needle, list]) => list.map((at) => ({ needle, at }))).sort((a, b) => a.at - b.at),
  )
  const numbers = texts.map((text, index) => numbersOnPage(text, where[index], normalise(seriesName)))

  interface Candidate extends VerifiedBook {
    /** How many fetched pages name this title. */
    support: number
    /** One page says this, the model says `position`: settled once the rest is known. */
    rival: number | null
  }
  const candidates: Candidate[] = []

  for (const [needle, book] of drafted) {
    const title = book.title.trim()
    const on = pages.map((_, index) => index).filter((index) => (where[index].get(needle) ?? []).length > 0)
    if (on.length === 0) {
      dropped.push({ title, reason: 'title not on any fetched page' })
      continue
    }

    // The number the pages give it; the model's own only if no page has one.
    const claimed = typeof book.position === 'number' && Number.isFinite(book.position) && book.position >= 0 ? book.position : null
    // Every page that numbers the title has a say, and so does the model,
    // which has read them all. A number the page ties to the series by name
    // counts double: a bare one may be counting something else. When the
    // model and the pages draw, it is settled further down by which of the
    // two fits the rest of the series.
    const found = on.flatMap((index) => {
      const entry = numbers[index].get(needle)
      return entry ? [entry] : []
    })
    const votes = found.map((entry) => entry.number)
    const weight = new Map<number, number>()
    for (const entry of found) weight.set(entry.number, (weight.get(entry.number) ?? 0) + (entry.labelled ? 2 : 1))
    if (claimed !== null) weight.set(claimed, (weight.get(claimed) ?? 0) + 1)
    const top = Math.max(0, ...weight.values())
    const leaders = [...weight.entries()].filter(([, value]) => value === top).map(([number]) => number)
    const position = leaders.length === 0 ? null : claimed !== null && leaders.includes(claimed) ? claimed : leaders[0]
    const rival = claimed !== null && leaders.includes(claimed) ? leaders.find((number) => number !== claimed) : undefined
    const drawn = rival !== undefined
    const byPages = rival ?? null
    if (position === null) {
      dropped.push({ title, reason: 'no position' })
      continue
    }

    // This book's own stretch of each page: up to the next drafted title.
    const segments = on.map((index) => {
      const otherStarts = starts[index].filter((other) => other.needle !== needle).map((other) => other.at)
      return { index, windows: segmentsFor(texts[index], needle, where[index].get(needle) ?? [], otherStarts) }
    })

    // The model's date, as precisely as any page backs it. Failing that, a
    // year written straight after the title — "Broken Bonds (2021)" — which
    // needs no model to read.
    let releaseDate: string | null = null
    let datePage = -1
    if (book.releaseDate) {
      for (const { index, windows } of segments) {
        const backed = supportedDate(book.releaseDate, windows)
        if (backed && backed.length > (releaseDate?.length ?? 0)) {
          releaseDate = backed
          datePage = index
        }
      }
    }
    if (releaseDate === null) {
      const years = segments.flatMap(({ index, windows }) =>
        windows.flatMap((window) => {
          const next = window.slice(needle.length).trim().split(' ')[0]
          return isYear(next) ? [{ index, year: next }] : []
        }),
      )
      const year = majority(years.map((item) => item.year))
      if (year) {
        releaseDate = year
        datePage = years.find((item) => item.year === year)?.index ?? -1
      } else if (book.releaseDate) {
        datesDropped += 1
      }
    }

    let hasAudio = false
    let audio: AudioInfo | null = null
    const audioClaim = book.audiobook
    if (audioClaim) {
      const audioWindows = segments.flatMap(({ windows }) => windows).filter((window) => /audio|audible|narrat/.test(window))
      hasAudio = audioWindows.length > 0
      if (hasAudio) {
        const year =
          audioClaim.year && audioWindows.some((window) => occurrences(window, audioClaim.year ?? '').length > 0)
            ? audioClaim.year
            : null
        const publisherText = audioClaim.publisher ? normalise(audioClaim.publisher) : ''
        const publisher =
          publisherText && audioWindows.some((window) => window.includes(publisherText)) ? audioClaim.publisher : null
        audio = year || publisher ? { year, publisher } : null
      }
    }

    const cited = pageIndex(book.source)
    const home = datePage >= 0 ? datePage : on.includes(cited) ? cited : on[0]
    candidates.push({
      title,
      position,
      positionFrom: votes.includes(position) ? 'pages' : 'model',
      rival: drawn ? byPages : null,
      releaseDate,
      url: pages[home].url,
      dateVerified: releaseDate !== null,
      resourced: !on.includes(cited),
      hasAudio,
      audio,
      support: on.length,
    })
  }

  // The draws. Whichever number does not collide with a settled book and
  // sits within reach of the others is the one that belongs to this series:
  // "35. Crave the Villain" on an author's list of everything she has
  // written loses to the model's 3 once books 1 and 2 are in place.
  const settled = candidates.filter((candidate) => candidate.rival === null).map((candidate) => candidate.position)
  const fits = (value: number) =>
    !settled.includes(value) && (settled.length === 0 || settled.some((other) => Math.abs(other - value) <= 2))
  for (const candidate of candidates) {
    if (candidate.rival === null) continue
    if (fits(candidate.rival) && !fits(candidate.position)) {
      candidate.position = candidate.rival
      candidate.positionFrom = 'pages'
    }
    settled.push(candidate.position)
  }

  // Two titles cannot both be book 4. The one more pages name is the
  // series' own; the other usually belongs to a sister series that a
  // "reading order" page lists alongside.
  const byPosition = new Map<number, Candidate>()
  for (const candidate of candidates) {
    const holder = byPosition.get(candidate.position)
    if (!holder) {
      byPosition.set(candidate.position, candidate)
      continue
    }
    const keep = candidate.support > holder.support ? candidate : holder
    const lose = keep === candidate ? holder : candidate
    byPosition.set(candidate.position, keep)
    dropped.push({ title: lose.title, reason: `same number (${lose.position}) as "${keep.title}", which more pages name` })
  }

  // A series runs 1, 2, 3 … A jump of more than one missing book means the
  // rest was numbered by some other scheme — a whole shared world, say.
  let books = [...byPosition.values()].sort((a, b) => a.position - b.position || a.title.localeCompare(b.title))
  const whole = books.filter((item) => Number.isInteger(item.position) && item.position >= 1).map((item) => item.position)
  const jump = whole.find((value, index) => index > 0 && value - whole[index - 1] > 2)
  if (jump !== undefined) {
    for (const item of books.filter((candidate) => candidate.position >= jump)) {
      dropped.push({ title: item.title, reason: `numbering jumps to ${jump}` })
    }
    books = books.filter((item) => item.position < jump)
  }

  // The advice has to be on the page in roughly those words: most of its
  // longer words, within a short stretch of text.
  let readingOrder: { note: string; url: string } | null = null
  if (draft.readingOrder) {
    const index = pageIndex(draft.readingOrder.source)
    const text = texts[index]
    const words = normalise(draft.readingOrder.note).split(' ').filter((word) => word.length > 4)
    if (text && words.length >= 3) {
      const present = words.filter((word) => text.includes(word)).length
      if (present / words.length >= 0.8 && text.includes('order')) {
        readingOrder = { note: draft.readingOrder.note.trim(), url: pages[index].url }
      }
    }
  }

  return {
    books: books.map(({ support: _support, rival: _rival, ...book }) => book),
    dropped,
    datesDropped,
    readingOrder,
  }
}

/**
 * A book with no date counts as out when a later book in the series has a
 * confirmed date in the past: nobody publishes book 5 before book 4.
 */
export function markReleasedInferred(books: VerifiedBook[], today: string): Set<number> {
  const inferred = new Set<number>()
  let laterPublished = false
  for (let index = books.length - 1; index >= 0; index -= 1) {
    const date = books[index].releaseDate
    if (date !== null) {
      // "2026" alone might still be ahead of us; only a period that has
      // wholly passed proves the book is out.
      const lastDay = date.length === 4 ? `${date}-12-31` : date.length === 7 ? `${date}-31` : date
      if (lastDay <= today) laterPublished = true
    } else if (laterPublished) {
      inferred.add(index)
    }
  }
  return inferred
}

export function toSeriesResult(
  query: SeriesQuery,
  seriesName: string | null,
  books: VerifiedBook[],
  readingOrder: { note: string; url: string } | null,
  today: string,
): AiSeriesResult {
  const inferred = markReleasedInferred(books, today)
  const volumes: AiVolume[] = books.map((book, index) => ({
    position: book.position,
    editions: [
      {
        title: book.title,
        releaseDate: book.releaseDate,
        languageId: null,
        readers: 0,
        coverUrl: null,
        coverColor: null,
        slug: null,
        hasAudio: book.hasAudio,
        audio: book.audio,
        ...(inferred.has(index) ? { releasedInferred: true } : {}),
      },
    ],
    evidence: { url: book.url, dateVerified: book.dateVerified, positionFrom: book.positionFrom },
  }))
  return {
    query: query.name,
    matchedName: seriesName ?? query.name,
    hardcoverId: null,
    totalBooks: books.filter((book) => Number.isInteger(book.position)).length,
    volumes,
    status: 'ok',
    source: 'ai',
    checkedAt: today,
    readingOrder,
  }
}

function notFound(query: SeriesQuery, today: string, detail: string): AiSeriesResult {
  return {
    query: query.name,
    matchedName: null,
    hardcoverId: null,
    totalBooks: null,
    volumes: [],
    status: 'not_found',
    detail,
    source: 'ai',
    checkedAt: today,
  }
}

/** One series, start to finish. Throws only what `search` or `runModel` throw. */
export async function aiLookupSeries(
  query: SeriesQuery,
  deps: { search: SearchFn; runModel: ModelFn; today: string },
): Promise<{ result: AiSeriesResult; report: AiReport; draft: Draft | null; pages: Page[] }> {
  const report: AiReport = {
    pages: [],
    drafted: 0,
    kept: 0,
    dropped: [],
    datesDropped: 0,
    numberedByModel: 0,
    resourced: 0,
    searches: 0,
    modelCalls: 0,
    ms: { search: 0, model: 0 },
  }

  let clock = Date.now()
  report.searches += 1
  let pages = choosePages(await deps.search(searchQueryFor(query)))
  if (!mentionsSeries(pages, query.name) && query.author) {
    // Nothing found is about this series. Ask once more, differently; it
    // costs a second search, and only for the few series that need it.
    report.searches += 1
    const again = choosePages(await deps.search(fallbackQueryFor(query)))
    if (mentionsSeries(again, query.name) || pages.length === 0) pages = again
  }
  report.ms.search = Date.now() - clock
  // Still nothing about the series: do not hand the model pages about
  // something else. It would find "books" in them.
  if (pages.length > 0 && query.author && !mentionsSeries(pages, query.name)) {
    report.pages = []
    return { result: notFound(query, deps.today, NOTHING_RELEVANT), report, draft: null, pages }
  }

  report.pages = pages.map((page) => ({
    url: page.url,
    title: page.title,
    chars: page.text.length,
    full: page.text.length > (page.snippet ?? '').length,
  }))
  if (pages.length === 0) {
    return { result: notFound(query, deps.today, 'no pages with text'), report, draft: null, pages }
  }

  clock = Date.now()
  report.modelCalls += 1
  const reply = await deps.runModel({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(query, pages),
    schema: DRAFT_SCHEMA,
  })
  report.ms.model = Date.now() - clock

  const draft = parseDraft(reply)
  if (!draft) {
    return { result: notFound(query, deps.today, 'model reply was not the JSON asked for'), report, draft, pages }
  }
  report.drafted = draft.books.length

  const verified = verifyAgainstPages(draft, pages, query.name)
  report.dropped = verified.dropped
  report.kept = verified.books.length
  report.resourced = verified.books.filter((book) => book.resourced).length
  report.datesDropped = verified.datesDropped
  report.numberedByModel = verified.books.filter((book) => book.positionFrom === 'model').length

  if (verified.books.length < MIN_BOOKS) {
    return { result: notFound(query, deps.today, TOO_FEW_BOOKS), report, draft, pages }
  }
  return {
    result: toSeriesResult(query, draft.seriesName, verified.books, verified.readingOrder, deps.today),
    report,
    draft,
    pages,
  }
}

/** Tavily's search, shaped into pages. See docs.tavily.com for the fields. */
export function tavilyRequestBody(query: string, depth: 'basic' | 'advanced' = 'basic'): Record<string, unknown> {
  return {
    query,
    // "advanced" costs two credits instead of one and returns longer
    // excerpts: up to three passages per source.
    search_depth: depth,
    ...(depth === 'advanced' ? { chunks_per_source: 3 } : {}),
    // More candidates for the same price; choosePages decides how each is read.
    max_results: 8,
    include_raw_content: 'markdown',
    include_answer: false,
    // Goodreads and Amazon are never read (see BLOCKED_HOSTS). Social sites
    // only take places from pages that list books: their excerpts are
    // chatter, and a post about a reprint gives the reprint's date.
    exclude_domains: [
      'goodreads.com',
      'amazon.com',
      'amazon.co.uk',
      'instagram.com',
      'facebook.com',
      'tiktok.com',
      'youtube.com',
      'reddit.com',
      'pinterest.com',
      'x.com',
      'twitter.com',
    ],
    include_usage: true,
  }
}

/**
 * Page text as a reader sees it. Tavily's markdown keeps every link target
 * and image, and on a shop or series page those are most of the characters:
 * the model would spend its attention, and our allowance, on URLs.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)/g, ' ')
    .replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    // Two passes that rarely match, not one that matches at every space:
    // on a long page that is the difference between 1 ms and 7.
    .replace(/[\t\u00a0]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * As much of a page as is read. A list of a series' books is a few thousand
 * characters, and the median page is nine thousand; the rare page past this
 * is something else entirely (one search returned a whole novel as a PDF),
 * and cleaning it would spend the Worker's CPU time on nothing.
 */
const MAX_RAW_CHARS = 100_000

export function pagesFromTavily(body: unknown): Page[] {
  const results = (body as { results?: unknown[] } | null)?.results
  if (!Array.isArray(results)) return []
  return results.flatMap((item) => {
    const row = item as { url?: unknown; title?: unknown; raw_content?: unknown; content?: unknown; score?: unknown }
    if (typeof row.url !== 'string') return []
    // `content` is the search's excerpt of the page; `raw_content` the page
    // itself, which many sites do not let the search fetch.
    const snippet = typeof row.content === 'string' ? plainText(row.content) : ''
    const body = typeof row.raw_content === 'string' ? plainText(row.raw_content.slice(0, MAX_RAW_CHARS)) : ''
    const text = [snippet, body].filter(Boolean).join('\n\n')
    const score = typeof row.score === 'number' ? { score: row.score } : {}
    return [{ url: row.url, title: typeof row.title === 'string' ? row.title : row.url, text, snippet, ...score }]
  })
}
