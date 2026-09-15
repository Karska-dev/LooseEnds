import type { Book } from './goodreads'

export interface SeriesRef {
  /** Display name as Goodreads wrote it. */
  name: string
  /** Normalised key used for grouping. */
  key: string
  /** Position in the series. Numeric so #2.5 sorts between 2 and 3. */
  position: number | null
  /** True for omnibus editions written as (Series, #1-3). */
  isOmnibus: boolean
}

export interface SeriesEntry {
  book: Book
  /** Title with the series suffix removed, for matching against editions. */
  cleanTitle: string
  position: number | null
  isOmnibus: boolean
}

export interface SeriesGroup {
  key: string
  name: string
  /** Most common author across the books, used to disambiguate lookups. */
  author: string
  entries: SeriesEntry[]
  readCount: number
  /** Highest position the reader has finished. The floor for "what's next". */
  highestReadPosition: number | null
  hasDnf: boolean
}

export interface SeriesSummary {
  groups: SeriesGroup[]
  unmatched: Book[]
  matchRate: number
}

/**
 * Goodreads appends the series to the title: "Words of Radiance
 * (The Stormlight Archive, #2)". Anchored at the end so a title with its own
 * parentheses keeps them, and a "#" is required so imprint names like
 * "(Vintage International)" are not mistaken for series.
 */
const SERIES_PATTERN =
  /\s*\(([^()]+?),?\s*#(\d+(?:\.\d+)?)(\s*-\s*\d+(?:\.\d+)?)?\)\s*$/

/** "The Stormlight Archive" and "Stormlight Archive" must land in one group. */
export function normaliseSeriesKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function extractSeries(rawTitle: string): {
  title: string
  series: SeriesRef | null
} {
  const match = rawTitle.match(SERIES_PATTERN)
  if (!match) return { title: rawTitle.trim(), series: null }

  const name = match[1].trim()
  if (name.length === 0) return { title: rawTitle.trim(), series: null }

  return {
    title: rawTitle.replace(SERIES_PATTERN, '').trim(),
    series: {
      name,
      key: normaliseSeriesKey(name),
      position: Number(match[2]),
      isOmnibus: match[3] !== undefined,
    },
  }
}

export function groupIntoSeries(books: Book[]): SeriesSummary {
  const byKey = new Map<string, { names: string[]; entries: SeriesEntry[] }>()
  const unmatched: Book[] = []

  for (const book of books) {
    const { title, series } = extractSeries(book.title)
    if (!series) {
      unmatched.push(book)
      continue
    }
    let group = byKey.get(series.key)
    if (!group) {
      group = { names: [], entries: [] }
      byKey.set(series.key, group)
    }
    group.names.push(series.name)
    group.entries.push({
      book,
      cleanTitle: title,
      position: series.position,
      isOmnibus: series.isOmnibus,
    })
  }

  const groups: SeriesGroup[] = []
  for (const [key, group] of byKey) {
    const entries = [...group.entries].sort(
      (a, b) => (a.position ?? Infinity) - (b.position ?? Infinity),
    )
    const readPositions = entries
      .filter((entry) => entry.book.shelf === 'read' && entry.position !== null)
      .map((entry) => entry.position as number)

    groups.push({
      key,
      name: mostCommon(group.names),
      author: mostCommon(entries.map((entry) => entry.book.author).filter(Boolean)),
      entries,
      readCount: entries.filter((entry) => entry.book.shelf === 'read').length,
      highestReadPosition: readPositions.length > 0 ? Math.max(...readPositions) : null,
      hasDnf: entries.some((entry) => entry.book.shelf === 'dnf'),
    })
  }

  groups.sort((a, b) => b.readCount - a.readCount || a.name.localeCompare(b.name))

  return {
    groups,
    unmatched,
    matchRate: books.length > 0 ? (books.length - unmatched.length) / books.length : 0,
  }
}

function mostCommon(values: string[]): string {
  const tally = new Map<string, number>()
  for (const value of values) tally.set(value, (tally.get(value) ?? 0) + 1)
  let best = values[0]
  let bestCount = 0
  for (const [value, count] of tally) {
    if (count > bestCount) {
      best = value
      bestCount = count
    }
  }
  return best
}
