import type { SeriesGroup } from './series'
import { TOO_FEW_BOOKS, normalise } from './shared/aiLookup.ts'
import type { AiSeriesResult } from './shared/aiLookup.ts'
import { buildSeriesState } from './state.ts'
import type { AiMiss, SeriesState } from './state.ts'

/**
 * The AI tab's side of the board.
 *
 * Hardcover's list and the reader's books are matched by number: Goodreads
 * says "#5" and Hardcover has a volume 5. That does not hold for a list read
 * off the open web. Sources disagree about numbering — one counts a novella
 * as a whole book and every later number moves up by one — and a list that
 * is off by one would mark the wrong books as read and offer a book the
 * reader finished last year.
 *
 * So here the reader's books are matched to the list by title, and the
 * number is only a fallback for a title the list words differently.
 */

type Entry = SeriesGroup['entries'][number]

/**
 * The forms a title is compared under: the whole title, and the title
 * without a subtitle or an edition note ("Fourth Wing: Special Edition",
 * "Powerless (Deluxe Edition)"). A leading article never decides a match.
 */
function titleKeys(title: string): string[] {
  const key = (value: string) => normalise(value).replace(/^(?:the|a|an) /, '')
  const full = key(title)
  const main = key(title.split(/:| [-–—] |\(/)[0])
  return main.length > 0 && main !== full ? [full, main] : [full]
}

/**
 * The reader's books, renumbered to the AI list.
 *
 *   1. A book whose title is on the list takes the number the list gives it.
 *   2. A book whose title is not on the list keeps its Goodreads number —
 *      unless the list's book at that number is, by title, another of the
 *      reader's books. Then its number is not known and it is left out of
 *      the list rather than laid over the wrong book.
 */
export function alignToAiTitles(group: SeriesGroup, result: AiSeriesResult): SeriesGroup {
  const listed = result.volumes.map((volume) => ({
    position: volume.position,
    keys: titleKeys(volume.editions[0]?.title ?? ''),
  }))
  const placed = new Map<Entry, number | null>()
  const taken = new Set<number>()

  // Whole titles first, so "Bride" never settles for "Bride: The Novella"
  // while a plain "Bride" is further down the list.
  for (const exact of [true, false]) {
    for (const entry of group.entries) {
      if (placed.has(entry)) continue
      const keys = titleKeys(entry.cleanTitle)
      const hit = listed.find((item) =>
        exact ? item.keys[0] === keys[0] : item.keys.some((key) => keys.includes(key)),
      )
      if (!hit) continue
      placed.set(entry, hit.position)
      taken.add(hit.position)
    }
  }

  const entries = group.entries
    .map((entry) => {
      const byTitle = placed.get(entry)
      if (byTitle !== undefined) return { ...entry, position: byTitle }
      if (entry.position !== null && taken.has(entry.position)) return { ...entry, position: null }
      return entry
    })
    .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity))

  const readPositions = entries
    .filter((entry) => entry.book.shelf === 'read' && entry.position !== null)
    .map((entry) => entry.position as number)

  return {
    ...group,
    entries,
    highestReadPosition: readPositions.length > 0 ? Math.max(...readPositions) : null,
  }
}

/** Why a lookup stopped, or one series failed, in the page's own terms. */
export type AiStop =
  /** Today's shared allowance, or the model's own daily limit. */
  | 'budget'
  /** The search plan's month. */
  | 'month'
  /** The server has no key or no model. */
  | 'unset'
  /** Turnstile did not pass. */
  | 'check'
  /** Rate limited. */
  | 'busy'
  | 'unreachable'

/**
 * Reads the server's words (worker/ai.ts, worker/index.ts). The same idea as
 * failureKind() in App.tsx, with the two limits told apart: one ends at
 * midnight UTC, the other at the end of the month.
 */
export function aiFailureKind(detail: string | null | undefined): AiStop {
  const text = (detail ?? '').toLowerCase()
  if (text.includes('daily')) return 'budget'
  if (text.includes('month')) return 'month'
  if (text.includes('not configured')) return 'unset'
  // CHECK_FAILED in src/turnstile.ts: "Couldn't confirm you're a person".
  if (text.includes('person')) return 'check'
  if (text.includes('too many') || text.includes('429')) return 'busy'
  return 'unreachable'
}

/** After this kind of failure, asking about the next series would fail the same way. */
export function stopsTheRun(kind: AiStop): boolean {
  return kind !== 'unreachable'
}

function missOf(result: AiSeriesResult): AiMiss {
  if (result.status === 'error') {
    const kind = aiFailureKind(result.detail)
    return kind === 'budget' ? 'allowance' : kind === 'month' ? 'month' : 'failed'
  }
  if (result.status === 'not_found' && result.detail !== TOO_FEW_BOOKS) return 'not_found'
  return 'not_confirmed'
}

/** One series as the AI tab shows it: looked up, missed, or not asked about yet. */
export function buildAiSeriesState(
  group: SeriesGroup,
  result: AiSeriesResult | undefined,
  today = new Date().toISOString().slice(0, 10),
): SeriesState {
  if (!result || result.status !== 'ok' || result.volumes.length === 0) {
    return {
      ...buildSeriesState(group, undefined, today),
      ai: {
        checkedAt: result?.checkedAt ?? null,
        readingOrder: null,
        miss: result ? missOf(result) : null,
        retryAfter: result?.retryAfter ?? null,
      },
    }
  }
  return {
    ...buildSeriesState(alignToAiTitles(group, result), result, today),
    ai: {
      checkedAt: result.checkedAt,
      readingOrder: result.readingOrder ?? null,
      miss: null,
      retryAfter: null,
    },
  }
}
