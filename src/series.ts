import type { Book } from './goodreads'

interface SeriesRef {
  /** Display name as Goodreads wrote it. */
  name: string
  /** Normalised key used for grouping. */
  key: string
  /** Position in the series. Numeric so #2.5 sorts between 2 and 3. */
  position: number | null
  /** True for omnibus editions written as (Series, #1-3). */
  isOmnibus: boolean
}

interface SeriesEntry {
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

function seriesKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Goodreads spells the same series both ways: this library has
 * "(Drixonian Warriors, #1)" and "(Drixonian Warrior, #0.5)". Left apart they
 * become two series, each reading "what's next" from half the shelf — one of
 * them offering a book the other shows as finished.
 *
 * Conservative on purpose: only a trailing plural "s", only on words long
 * enough to survive it, and never on endings where the "s" is part of the
 * word ("bliss", "chaos", "Atlas").
 */
function singularise(key: string): string {
  return key
    .split(' ')
    .map((word) =>
      word.length > 3 && word.endsWith('s') && !/(ss|us|is|as|os)$/.test(word)
        ? word.slice(0, -1)
        : word,
    )
    .join(' ')
}

function normaliseAuthor(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function extractSeries(rawTitle: string): {
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
      key: seriesKey(name),
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
  for (const group of mergeInflections(byKey)) {
    const entries = [...group.entries].sort(
      (a, b) => (a.position ?? Infinity) - (b.position ?? Infinity),
    )
    const readPositions = entries
      .filter((entry) => entry.book.shelf === 'read' && entry.position !== null)
      .map((entry) => entry.position as number)

    const name = mostCommon(group.names)
    groups.push({
      // Derived from the winning spelling, so the key matches the name shown.
      key: seriesKey(name),
      name,
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

interface Bucket {
  names: string[]
  entries: SeriesEntry[]
}

/**
 * Folds together buckets whose names differ only by a plural, and only when
 * the author agrees — "Shadow" and "Shadows" by different authors are two
 * series, not one badly spelled one.
 */
function mergeInflections(byKey: Map<string, Bucket>): Bucket[] {
  const merged = new Map<string, Bucket>()

  for (const [key, bucket] of byKey) {
    const author = mostCommon(bucket.entries.map((entry) => entry.book.author).filter(Boolean))
    const mergeKey = `${singularise(key)}|${normaliseAuthor(author ?? '')}`
    const existing = merged.get(mergeKey)
    if (existing) {
      existing.names.push(...bucket.names)
      existing.entries.push(...bucket.entries)
    } else {
      merged.set(mergeKey, { names: [...bucket.names], entries: [...bucket.entries] })
    }
  }

  return [...merged.values()]
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
