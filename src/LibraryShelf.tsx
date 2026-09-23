import type { Book, Shelf } from './goodreads'

/**
 * Past this many books a spine per book would not fit the shelf, so the
 * spines become proportional: each shelf keeps its share, and every shelf
 * with at least one book keeps at least one spine. The legend underneath
 * always carries the real counts.
 */
const MAX_SPINES = 36

const ORDER: Shelf[] = ['read', 'reading', 'to_read', 'dnf']

const LABEL: Record<Shelf, string> = {
  read: 'read',
  reading: 'reading',
  to_read: 'to read',
  dnf: 'did not finish',
}

/* A fixed rhythm, not random: the same library always draws the same shelf. */
const HEIGHTS = [91, 78, 97, 72, 86, 94, 75, 81, 100, 70, 89]
const WIDTHS = [14, 12, 16, 13, 15, 12, 14]

function spineCounts(counts: Record<Shelf, number>, total: number): Record<Shelf, number> {
  if (total <= MAX_SPINES) return counts

  // Largest remainder, with a floor of one for any shelf that has books.
  const exact = ORDER.map((shelf) => (counts[shelf] / total) * MAX_SPINES)
  const out = ORDER.map((shelf, i) => (counts[shelf] > 0 ? Math.max(1, Math.floor(exact[i])) : 0))
  let left = MAX_SPINES - out.reduce((a, b) => a + b, 0)
  const byRemainder = ORDER.map((_, i) => i).sort(
    (a, b) => exact[b] - Math.floor(exact[b]) - (exact[a] - Math.floor(exact[a])),
  )
  for (const i of byRemainder) {
    if (left <= 0) break
    if (counts[ORDER[i]] > 0) {
      out[i] += 1
      left -= 1
    }
  }
  return Object.fromEntries(ORDER.map((shelf, i) => [shelf, out[i]])) as Record<Shelf, number>
}

/**
 * The loaded library, drawn as a shelf: one spine per book, coloured by
 * Goodreads shelf, with the number the lookup is about to use set apart.
 */
export function LibraryShelf({
  name,
  books,
  counts,
  standalone,
  onReset,
}: {
  name: string
  books: Book[]
  counts: Record<Shelf, number>
  /** Books that belong to no series. */
  standalone: number
  onReset: () => void
}) {
  const total = books.length
  const inSeries = total - standalone
  const drawn = spineCounts(counts, total)

  const spines: { shelf: Shelf; width: number; height: number }[] = []
  for (const shelf of ORDER) {
    for (let n = 0; n < drawn[shelf]; n += 1) {
      const i = spines.length
      spines.push({ shelf, width: WIDTHS[i % WIDTHS.length], height: HEIGHTS[i % HEIGHTS.length] })
    }
  }

  return (
    <div className="library">
      <div className="library-main">
        <p className="library-head">
          <b className="library-name">{name}</b>
          <span className="library-count">
            {total} book{total === 1 ? '' : 's'}
          </span>
        </p>

        {/* Decoration: the legend below says the same thing in words. */}
        <div className="shelf" aria-hidden="true">
          {spines.map((spine, i) => (
            <span
              key={i}
              className={`spine spine-${spine.shelf}`}
              style={{ flexBasis: `${spine.width}px`, height: `${spine.height}%` }}
            />
          ))}
        </div>

        <ul className="shelf-legend">
          {ORDER.filter((shelf) => counts[shelf] > 0).map((shelf) => (
            <li key={shelf}>
              <span className={`swatch spine-${shelf}`} aria-hidden="true" />
              <b>{counts[shelf]}</b> {LABEL[shelf]}
            </li>
          ))}
        </ul>
      </div>

      <div className="library-side">
        <button type="button" className="change-file" onClick={onReset}>
          Use a different file
        </button>

        <p className="series-count">
          <span className="series-count-n">{inSeries}</span>
          <span className="series-count-label">
            {inSeries === 1 ? 'book belongs' : 'books belong'} to a series
          </span>
          {standalone > 0 && (
            <span className="series-count-rest">
              {standalone} more {standalone === 1 ? 'stands' : 'stand'} alone
            </span>
          )}
        </p>
      </div>
    </div>
  )
}
