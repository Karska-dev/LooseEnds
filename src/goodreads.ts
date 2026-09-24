import Papa from 'papaparse'

/** Where a book sits in the reader's library. */
export type Shelf = 'read' | 'reading' | 'to_read' | 'dnf'

export interface Book {
  title: string
  author: string
  isbn13: string | null
  shelf: Shelf
  dateRead: string | null
  rating: number | null
  /** First publication, from the export; the lookup's date wins when there is one. */
  year: number | null
  binding: string | null
  shelves: string[]
}

export interface ParseResult {
  books: Book[]
  counts: Record<Shelf, number>
  /** How many read books carry a usable Date Read. Gates every monthly statistic. */
  dateReadCoverage: { withDate: number; total: number }
  skipped: number
}

/**
 * Goodreads has only three exclusive shelves. "Did not finish" is always a
 * custom shelf the reader invented, and they spell it many different ways.
 */
const DNF_PATTERN =
  /^(dnf|did-?not-?finish|didn-?t-?finish|abandoned|gave-?up|unfinished|quit)/i

/** Goodreads armours identifiers against Excel as ="9780765311788". */
function cleanIdentifier(value: string | undefined): string | null {
  if (!value) return null
  const cleaned = value.replace(/^="?/, '').replace(/"$/, '').trim()
  return cleaned.length > 0 ? cleaned : null
}

/** Goodreads writes dates as YYYY/MM/DD. Empty is very common and expected. */
function parseDate(value: string | undefined): string | null {
  const raw = value?.trim()
  if (!raw) return null
  const slashed = raw.match(/^(\d{4})\/(\d{2})\/(\d{2})$/)
  if (slashed) return `${slashed[1]}-${slashed[2]}-${slashed[3]}`
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10)
}

function splitShelves(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((shelf) => shelf.trim())
    .filter((shelf) => shelf.length > 0)
}

/**
 * A DNF marking beats the exclusive shelf: readers who abandon a book often
 * leave it on "read" or "to-read" and record the fact on a custom shelf.
 */
function toShelf(exclusive: string | undefined, shelves: string[]): Shelf {
  if (shelves.some((shelf) => DNF_PATTERN.test(shelf))) return 'dnf'
  switch (exclusive?.trim()) {
    case 'read':
      return 'read'
    case 'currently-reading':
      return 'reading'
    default:
      return 'to_read'
  }
}

type Row = Record<string, string | undefined>

/** Goodreads leaves the year blank, or writes it with stray spaces. */
function parseYear(value: string | undefined): number | null {
  const year = Number(value?.trim())
  return Number.isInteger(year) && year > 0 ? year : null
}

export function parseGoodreadsCsv(text: string): ParseResult {
  const parsed = Papa.parse<Row>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim(),
  })

  const books: Book[] = []
  let skipped = 0

  for (const row of parsed.data) {
    const title = row['Title']?.trim()
    if (!title) {
      skipped += 1
      continue
    }

    const shelves = splitShelves(row['Bookshelves'])
    const ratingValue = Number(row['My Rating'] ?? '0')

    books.push({
      title,
      author: row['Author']?.trim() ?? '',
      isbn13: cleanIdentifier(row['ISBN13']) ?? cleanIdentifier(row['ISBN']),
      shelf: toShelf(row['Exclusive Shelf'], shelves),
      dateRead: parseDate(row['Date Read']),
      rating: ratingValue > 0 ? ratingValue : null,
      year: parseYear(row['Original Publication Year']) ?? parseYear(row['Year Published']),
      binding: row['Binding']?.trim() || null,
      shelves,
    })
  }

  const counts: Record<Shelf, number> = { read: 0, reading: 0, to_read: 0, dnf: 0 }
  for (const book of books) counts[book.shelf] += 1

  const readBooks = books.filter((book) => book.shelf === 'read')

  return {
    books,
    counts,
    dateReadCoverage: {
      withDate: readBooks.filter((book) => book.dateRead !== null).length,
      total: readBooks.length,
    },
    skipped,
  }
}
