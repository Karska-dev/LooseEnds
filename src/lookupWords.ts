import type { Messages } from './i18n/index.ts'
import type { SeriesState } from './state'

/**
 * Words the two lookup panels share (LookupPanel, AiLookupPanel). Kept out
 * of the component files: a file that exports anything besides components
 * cannot be hot-reloaded in place.
 */

type BadgeKind = 'go' | 'soon' | 'wait' | 'done'

/**
 * One line per series that came back: the same verdict the row shows, shorter.
 *
 * Pattern: dependency injection. The words (`t`) are handed in rather than
 * looked up from here, so this stays a plain function of its arguments: the
 * same state and the same language always give the same line, and a test can
 * call it without a page.
 */
export function brief(state: SeriesState, t: Messages): { kind: BadgeKind; label: string; text: string } {
  const words = t.brief
  const next = state.next
  if (state.inProgress) {
    return {
      kind: 'soon',
      label: words.reading,
      text: state.inProgressPosition !== null ? words.onNumber(state.inProgressPosition) : words.onIt,
    }
  }
  if (state.status === 'next_available' && next) {
    return { kind: 'go', label: words.next, text: words.numbered(next.position, next.title) }
  }
  if (state.status === 'waiting' && next) {
    return next.publication === 'announced'
      ? { kind: 'wait', label: words.due, text: `${words.numbered(next.position, next.title)}, ${next.releaseDate}` }
      : { kind: 'wait', label: words.waiting, text: words.numbered(next.position, next.title) }
  }
  if (state.status === 'complete') return { kind: 'done', label: words.finished, text: words.allRead }
  if (state.status === 'reading') return { kind: 'soon', label: words.reading, text: words.lastOne }
  return { kind: 'done', label: words.caughtUp, text: words.nothingLeft }
}
