import type { Book, Shelf } from '../src/goodreads.ts'
import type { SeriesGroup } from '../src/series.ts'
import type { Edition, SeriesResult, Volume } from '../src/shared/hardcover.ts'
import { groupIntoSeries } from '../src/series.ts'

/**
 * Fixtures are written as Goodreads titles and run through the real parser,
 * so a change to series extraction shows up here rather than silently
 * invalidating every expectation below.
 */
export function booksOf(
  rows: Array<[Shelf, string] | [Shelf, string, Partial<Book>]>,
): Book[] {
  return rows.map(([shelf, title, extra]) => ({
    title,
    author: 'Test Author',
    isbn13: null,
    shelf,
    dateRead: shelf === 'read' ? '2026-01-01' : null,
    rating: null,
    binding: null,
    shelves: [],
    ...extra,
  }))
}

export function groupOf(
  rows: Array<[Shelf, string] | [Shelf, string, Partial<Book>]>,
): SeriesGroup {
  const summary = groupIntoSeries(booksOf(rows))
  const group = summary.groups[0]
  if (!group) throw new Error('fixture produced no series group')
  return group
}

export function edition(overrides: Partial<Edition> = {}): Edition {
  return {
    title: 'Volume',
    releaseDate: '2020-01-01',
    languageId: 1,
    readers: 100,
    coverUrl: null,
    coverColor: null,
    slug: null,
    ...overrides,
  }
}

/** A volume with a single English edition, which is the ordinary case. */
export function volume(position: number, overrides: Partial<Edition> = {}): Volume {
  return { position, editions: [edition({ title: `Volume ${position}`, ...overrides })] }
}

export function resolved(volumes: Volume[], totalBooks?: number): SeriesResult {
  return {
    query: 'test series',
    matchedName: 'Test Series',
    hardcoverId: 1,
    totalBooks: totalBooks ?? volumes.length,
    volumes,
    status: 'ok',
  }
}

/** Fixed "today" so date-dependent expectations never rot. */
export const TODAY = '2026-06-15'
export const PAST = '2020-01-01'
export const FUTURE = '2027-03-01'
