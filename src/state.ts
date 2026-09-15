import type { SeriesGroup } from './series'
import type { Edition, SeriesResult, Volume } from './shared/hardcover'

export type PublicationState = 'published' | 'announced' | 'unannounced'

export type SeriesStatus =
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

export interface NextVolume {
  position: number
  title: string
  releaseDate: string | null
  publication: PublicationState
  /** Already on the reader's to-read shelf: a nudge, not a discovery. */
  onYourList: boolean
}

export interface SeriesState {
  key: string
  name: string
  author: string
  readCount: number
  totalBooks: number | null
  next: NextVolume | null
  status: SeriesStatus
  /** A DNF anywhere in the series is a strong signal the reader stopped. */
  suggestDismiss: boolean
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

function pickNext(volumes: Volume[], shelves: Shelves): Volume | null {
  // Main-line books only. Novellas at #2.5 are opt-in, not the default answer.
  const mainLine = volumes.filter((volume) => Number.isInteger(volume.position))
  return mainLine.find((volume) => !isBlocked(shelves, volume.position)) ?? null
}

/**
 * Hardcover language id for English. This version shows English editions only;
 * the API still returns every language, so reading the edition in the reader's
 * own language is a later version, not a rewrite.
 */
const ENGLISH = 1

/** Keeps the whole series in one language instead of a mix of translations. */
export function chooseEdition(volume: Volume): Edition | null {
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
  const base = {
    key: group.key,
    name: group.name,
    author: group.author,
    readCount: group.readCount,
    suggestDismiss: group.hasDnf,
  }

  if (!resolved || resolved.volumes.length === 0) {
    return { ...base, totalBooks: null, next: null, status: 'unknown' }
  }

  const shelves = shelvesByPosition(group)
  const totalBooks = resolved.totalBooks ?? resolved.volumes.length
  const mainLine = resolved.volumes.filter((volume) => Number.isInteger(volume.position))
  const nextVolume = pickNext(resolved.volumes, shelves)

  if (!nextVolume) {
    const readingNow = [...shelves.entries()].some(([position]) =>
      has(shelves, position, 'reading'),
    )
    if (readingNow) {
      return { ...base, totalBooks, next: null, status: 'reading' }
    }
    // Never claim a series is finished on the strength of a short volume list.
    const listLooksComplete = mainLine.length >= totalBooks
    return {
      ...base,
      totalBooks,
      next: null,
      status: listLooksComplete ? 'complete' : 'partial',
    }
  }

  const edition = chooseEdition(nextVolume)
  if (!edition) {
    return { ...base, totalBooks, next: null, status: 'partial' }
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
    status: publication === 'published' ? 'next_available' : 'waiting',
  }
}

/**
 * Reading order of attention: the book in your hands, then dates you are
 * waiting on, then what you could start tonight, then the rest.
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
      rank(a) - rank(b) ||
      (a.next?.releaseDate ?? '').localeCompare(b.next?.releaseDate ?? '') ||
      b.readCount - a.readCount ||
      a.name.localeCompare(b.name),
  )
}
