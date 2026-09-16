import type { Shelf } from './goodreads'
import type { SeriesGroup } from './series'
import type { Edition, SeriesResult, Volume } from './shared/hardcover'

type PublicationState = 'published' | 'announced' | 'unannounced'

type SeriesStatus =
  /** The next book exists and is out. Act on this one. */
  | 'next_available'
  /** Mid-book right now. */
  | 'reading'
  /** Caught up; the next book has a future date or none yet. */
  | 'waiting'
  /** Every main-line volume read. */
  | 'complete'
  /** Hardcover returned fewer volumes than it says the series has. */
  | 'partial'
  /** Not looked up. */
  | 'unknown'

interface NextVolume {
  position: number
  title: string
  releaseDate: string | null
  publication: PublicationState
  /** Already on the reader's to-read shelf: a nudge, not a discovery. */
  onYourList: boolean
}

/** One book in the series, with whatever the reader's own library says about it. */
export interface VolumeRow {
  position: number
  title: string
  coverUrl: string | null
  slug: string | null
  releaseDate: string | null
  publication: PublicationState
  isNext: boolean
  /** Null when the reader does not have this volume at all. */
  mine: {
    shelf: Shelf
    title: string
    dateRead: string | null
    rating: number | null
  } | null
}

export interface SeriesState {
  key: string
  name: string
  author: string
  readCount: number
  totalBooks: number | null
  next: NextVolume | null
  /** Cover of the first volume, the thing that makes the list scannable. */
  coverUrl: string | null
  /** Every volume in order, for the expanded view. */
  rows: VolumeRow[]
  status: SeriesStatus
  /** A DNF anywhere in the series is a strong signal the reader stopped. */
  suggestDismiss: boolean
  /**
   * A volume is on the reading shelf — the book physically in your hands.
   * Distinct from status 'reading', which only fires when nothing remains
   * after it. Reading book 2 of 5 is still reading.
   */
  inProgress: boolean
  /** Which volume that is, so the board can say so. */
  inProgressPosition: number | null
}

function publicationOf(releaseDate: string | null, today: string): PublicationState {
  if (!releaseDate) return 'unannounced'
  return releaseDate > today ? 'announced' : 'published'
}

type Shelves = Map<number, Set<string>>

function shelvesByPosition(group: SeriesGroup): Shelves {
  const map: Shelves = new Map()
  for (const entry of group.entries) {
    if (entry.position === null) continue
    let set = map.get(entry.position)
    if (!set) {
      set = new Set()
      map.set(entry.position, set)
    }
    set.add(entry.book.shelf)
  }
  return map
}

function has(shelves: Shelves, position: number, shelf: string): boolean {
  return shelves.get(position)?.has(shelf) ?? false
}

/**
 * A book is out of the running only if it is finished, in progress, or
 * abandoned. Being on the to-read shelf does NOT disqualify it — a queued
 * book is still the answer to "what next", just one the reader already knows
 * about.
 */
function isBlocked(shelves: Shelves, position: number): boolean {
  return (
    has(shelves, position, 'read') ||
    has(shelves, position, 'reading') ||
    has(shelves, position, 'dnf')
  )
}

/**
 * Main-line books only: whole numbers from 1 up. Novellas sit at #2.5, and
 * position 0 is where box sets and anthologies live — "Hunger Games 4-Book
 * Collection" is not the next book in the series.
 */
function isMainLine(position: number): boolean {
  return Number.isInteger(position) && position >= 1
}

function pickNext(volumes: Volume[], shelves: Shelves): Volume | null {
  return volumes.filter((volume) => isMainLine(volume.position)).find(
    (volume) => !isBlocked(shelves, volume.position),
  ) ?? null
}

/**
 * Hardcover language id for English. This version shows English editions only;
 * the API still returns every language, so reading the edition in the reader's
 * own language is a later version, not a rewrite.
 */
const ENGLISH = 1

/** Keeps the whole series in one language instead of a mix of translations. */
function chooseEdition(volume: Volume): Edition | null {
  if (volume.editions.length === 0) return null
  const english = volume.editions.find((edition) => edition.languageId === ENGLISH)
  // No English edition: fall back to the most-read one rather than showing nothing.
  return english ?? volume.editions[0]
}

export function buildSeriesState(
  group: SeriesGroup,
  resolved: SeriesResult | undefined,
  today = new Date().toISOString().slice(0, 10),
): SeriesState {
  const readingPositions = group.entries
    .filter((entry) => entry.book.shelf === 'reading' && entry.position !== null)
    .map((entry) => entry.position as number)

  const base = {
    key: group.key,
    name: group.name,
    author: group.author,
    readCount: group.readCount,
    suggestDismiss: group.hasDnf,
    inProgress: group.entries.some((entry) => entry.book.shelf === 'reading'),
    inProgressPosition: readingPositions.length > 0 ? Math.min(...readingPositions) : null,
  }

  if (!resolved || resolved.volumes.length === 0) {
    return {
      ...base,
      totalBooks: null,
      next: null,
      rows: rowsFromLibraryOnly(group, today),
      coverUrl: null,
      status: 'unknown',
    }
  }

  const shelves = shelvesByPosition(group)
  const totalBooks = resolved.totalBooks ?? resolved.volumes.length
  const mainLine = resolved.volumes.filter((volume) => isMainLine(volume.position))
  const nextVolume = pickNext(resolved.volumes, shelves)

  const rows = buildRows(group, resolved.volumes, nextVolume?.position ?? null, today)
  const coverUrl =
    rows.find((row) => row.position === 1 && row.coverUrl)?.coverUrl ??
    rows.find((row) => row.coverUrl)?.coverUrl ??
    null

  if (!nextVolume) {
    const readingNow = [...shelves.entries()].some(([position]) =>
      has(shelves, position, 'reading'),
    )
    if (readingNow) {
      return { ...base, totalBooks, next: null, rows, coverUrl, status: 'reading' }
    }
    // Finished means every main-line slot is accounted for — read, abandoned,
    // or both. A DNF is a decision, not a gap. Accept either Hardcover's list
    // covering the series, or the reader having handled that many positions,
    // since Hardcover's volume lists are sometimes shorter than its own count.
    const handledCount = [...shelves.keys()].filter(
      (position) => isMainLine(position) && isBlocked(shelves, position),
    ).length
    const listLooksComplete = mainLine.length >= totalBooks || handledCount >= totalBooks
    return {
      ...base,
      totalBooks,
      next: null,
      rows,
      coverUrl,
      status: listLooksComplete ? 'complete' : 'partial',
    }
  }

  const edition = chooseEdition(nextVolume)
  if (!edition) {
    return { ...base, totalBooks, next: null, rows, coverUrl, status: 'partial' }
  }

  const publication = publicationOf(edition.releaseDate, today)
  return {
    ...base,
    totalBooks,
    next: {
      position: nextVolume.position,
      title: edition.title,
      releaseDate: edition.releaseDate,
      publication,
      onYourList: has(shelves, nextVolume.position, 'to_read'),
    },
    rows,
    coverUrl,
    status: publication === 'published' ? 'next_available' : 'waiting',
  }
}

const SHELF_RANK: Record<Shelf, number> = { read: 0, reading: 1, dnf: 2, to_read: 3 }

/** One entry per position; a finished copy outranks a wishlist copy. */
function myBooksByPosition(group: SeriesGroup): Map<number, VolumeRow['mine']> {
  const map = new Map<number, NonNullable<VolumeRow['mine']>>()
  for (const entry of group.entries) {
    if (entry.position === null) continue
    const candidate = {
      shelf: entry.book.shelf,
      title: entry.cleanTitle,
      dateRead: entry.book.dateRead,
      rating: entry.book.rating,
    }
    const current = map.get(entry.position)
    if (!current || SHELF_RANK[candidate.shelf] < SHELF_RANK[current.shelf]) {
      map.set(entry.position, candidate)
    }
  }
  return map
}

function buildRows(
  group: SeriesGroup,
  volumes: Volume[],
  nextPosition: number | null,
  today: string,
): VolumeRow[] {
  const mine = myBooksByPosition(group)
  const rows: VolumeRow[] = []
  const seen = new Set<number>()

  for (const volume of volumes) {
    const edition = chooseEdition(volume)
    if (!edition) continue
    seen.add(volume.position)
    rows.push({
      position: volume.position,
      title: edition.title,
      coverUrl: edition.coverUrl,
      slug: edition.slug,
      releaseDate: edition.releaseDate,
      publication: publicationOf(edition.releaseDate, today),
      isNext: volume.position === nextPosition,
      mine: mine.get(volume.position) ?? null,
    })
  }

  // Books the reader owns that Hardcover's list does not include.
  for (const [position, entry] of mine) {
    if (seen.has(position)) continue
    rows.push({
      position,
      title: entry!.title,
      coverUrl: null,
      slug: null,
      releaseDate: null,
      publication: 'unannounced',
      isNext: false,
      mine: entry,
    })
  }

  return rows.sort((a, b) => a.position - b.position)
}

function rowsFromLibraryOnly(group: SeriesGroup, today: string): VolumeRow[] {
  return buildRows(group, [], null, today)
}

/**
 * Reading order of attention: the book in your hands, then dates you are
 * waiting on, then what you could start tonight, then the rest.
 *
 * `rank` orders by what to do next; a book already open outranks all of it,
 * which is why sortSeriesStates checks inProgress before calling this.
 */
function rank(state: SeriesState): number {
  switch (state.status) {
    case 'reading':
      return 0
    case 'waiting':
      return state.next?.publication === 'announced' ? 1 : 3
    case 'next_available':
      return 2
    case 'partial':
      return 4
    case 'unknown':
      return 5
    case 'complete':
      return 6
  }
}

export function sortSeriesStates(states: SeriesState[]): SeriesState[] {
  return [...states].sort(
    (a, b) =>
      // A series you are part-way through beats one you merely could start,
      // whatever its status says about the next action.
      Number(b.inProgress) - Number(a.inProgress) ||
      rank(a) - rank(b) ||
      (a.next?.releaseDate ?? '').localeCompare(b.next?.releaseDate ?? '') ||
      b.readCount - a.readCount ||
      a.name.localeCompare(b.name),
  )
}
