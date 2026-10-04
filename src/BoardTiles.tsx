import { useLanguage } from './language.ts'
import { TILES } from './state'
import type { Tile } from './state'

/* The class names predate the switches; the skins still key off them. */
const CLASS: Record<Tile, string> = {
  ready: 'tile-ready',
  reading: 'tile-reading',
  waiting: 'tile-waiting',
  finished: 'tile-done',
  aside: 'tile-aside',
}

/** Open eye when the group is in the list, crossed out when it is hidden. */
function Eye({ open }: { open: boolean }) {
  return (
    <svg className="tile-eye" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
      {!open && <path d="M3 3l18 18" />}
    </svg>
  )
}

/**
 * The five counts, each one also the switch for its own series in the list.
 * Real toggle buttons, so the keyboard and screen readers get them for free.
 */
export function BoardTiles({
  counts,
  visible,
  onToggle,
}: {
  counts: Record<Tile, number>
  visible: Readonly<Record<Tile, boolean>>
  onToggle: (tile: Tile) => void
}) {
  const { t } = useLanguage()
  return (
    <div className="tiles" role="group" aria-label={t.tiles.group}>
      {TILES.map((tile) => {
        const on = visible[tile]
        const n = counts[tile]
        return (
          <button
            key={tile}
            type="button"
            className={`tile ${CLASS[tile]}`}
            aria-pressed={on}
            aria-label={t.tiles.aria(t.tiles.label[tile], n, on)}
            onClick={() => onToggle(tile)}
          >
            <span className="tile-n">{n}</span>
            <span className="tile-label">
              <span className="tile-dot" aria-hidden="true" />
              {t.tiles.label[tile]}
            </span>
            <Eye open={on} />
          </button>
        )
      })}
    </div>
  )
}

/** "Showing 6 series", and what is hidden with a way back when anything is. */
export function ListHead({
  shown,
  visible,
  counts,
  onShowAll,
}: {
  shown: number
  visible: Readonly<Record<Tile, boolean>>
  counts: Record<Tile, number>
  onShowAll: () => void
}) {
  const { t } = useLanguage()
  // Only groups that actually hold series are worth naming as hidden.
  const hidden = TILES.filter((tile) => !visible[tile] && counts[tile] > 0).map((tile) => t.tiles.label[tile])
  return (
    <div className="list-head">
      <span className="list-count" aria-live="polite">
        {t.tiles.showing(shown)}
      </span>
      {hidden.length > 0 && (
        <>
          <span className="list-hidden">{t.tiles.hidden(hidden)}</span>
          <button type="button" className="ghost list-show-all" onClick={onShowAll}>
            {t.tiles.showAll}
          </button>
        </>
      )}
    </div>
  )
}
