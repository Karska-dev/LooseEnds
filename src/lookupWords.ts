import type { SeriesState } from './state'

/**
 * Words the two lookup panels share (LookupPanel, AiLookupPanel). Kept out
 * of the component files: a file that exports anything besides components
 * cannot be hot-reloaded in place.
 */

type BadgeKind = 'go' | 'soon' | 'wait' | 'done'

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']

export function word(n: number, capital = false): string {
  const text = n < WORDS.length ? WORDS[n] : String(n)
  return capital ? text : text.toLowerCase()
}

/** "A", "A and B", "A, B and C", then "A, B, C and 2 more". */
export function listNames(names: string[]): string {
  if (names.length === 0) return ''
  const shown = names.length > 3 ? names.slice(0, 3) : names
  const rest = names.length - shown.length
  const parts = rest > 0 ? [...shown, `${rest} more`] : shown
  if (parts.length === 1) return parts[0]
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** One line per series that came back: the same verdict the row shows, shorter. */
export function brief(state: SeriesState): { kind: BadgeKind; label: string; text: string } {
  const next = state.next
  if (state.inProgress) {
    return {
      kind: 'soon',
      label: 'Reading',
      text: state.inProgressPosition !== null ? `you’re on #${state.inProgressPosition}` : 'you’re on it',
    }
  }
  if (state.status === 'next_available' && next) {
    return { kind: 'go', label: 'Next', text: `#${next.position} ${next.title}` }
  }
  if (state.status === 'waiting' && next) {
    return next.publication === 'announced'
      ? { kind: 'wait', label: 'Due', text: `#${next.position} ${next.title}, ${next.releaseDate}` }
      : { kind: 'wait', label: 'Waiting', text: `#${next.position} ${next.title}` }
  }
  if (state.status === 'complete') return { kind: 'done', label: 'Finished', text: 'all read' }
  if (state.status === 'reading') return { kind: 'soon', label: 'Reading', text: 'the last one' }
  return { kind: 'done', label: 'Caught up', text: 'nothing left to read' }
}
