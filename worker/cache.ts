import type { SeriesResult, Volume } from '../src/shared/hardcover'

/** Minimal shape of the D1 binding, so we need no extra dependency. */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  all<T>(): Promise<{ results: T[] }>
  run(): Promise<unknown>
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement
  batch(statements: D1PreparedStatement[]): Promise<unknown>
}

interface CacheRow {
  cache_key: string
  payload: string
  fetched_at: number
  has_unreleased: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/** A series whose volumes are all published cannot change. */
const SETTLED_MAX_AGE_MS = 30 * DAY_MS

/**
 * A series with an unreleased or undated volume can change — that is the
 * information readers are waiting on. Daily is frequent enough to catch a
 * date being announced, and bounds the upstream cost at one call per series
 * per day however many people ask.
 */
const PENDING_MAX_AGE_MS = DAY_MS

export function cacheKey(name: string, author?: string): string {
  const normalise = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  return author ? `${normalise(name)}|${normalise(author)}` : normalise(name)
}

/** Out if any edition of it is out; a missing date is not evidence of release. */
function volumeReleased(volume: Volume, today: string): boolean {
  return volume.editions.some(
    (edition) => edition.releaseDate !== null && edition.releaseDate <= today,
  )
}

export function hasUnreleasedVolume(result: SeriesResult, today: string): boolean {
  return result.volumes.some((volume) => !volumeReleased(volume, today))
}

export interface CacheLookup {
  hits: Map<string, SeriesResult>
  misses: string[]
}

export async function readCache(
  db: D1Database,
  keys: string[],
  now: number,
): Promise<CacheLookup> {
  const hits = new Map<string, SeriesResult>()
  if (keys.length === 0) return { hits, misses: [] }

  const placeholders = keys.map(() => '?').join(',')
  const { results } = await db
    .prepare(
      `SELECT cache_key, payload, fetched_at, has_unreleased
       FROM series_cache WHERE cache_key IN (${placeholders})`,
    )
    .bind(...keys)
    .all<CacheRow>()

  for (const row of results) {
    const maxAge = row.has_unreleased === 1 ? PENDING_MAX_AGE_MS : SETTLED_MAX_AGE_MS
    if (now - row.fetched_at >= maxAge) continue
    try {
      hits.set(row.cache_key, JSON.parse(row.payload) as SeriesResult)
    } catch {
      // Corrupt row: treat as a miss and let the write below replace it.
    }
  }

  return { hits, misses: keys.filter((key) => !hits.has(key)) }
}

export async function writeCache(
  db: D1Database,
  entries: { key: string; result: SeriesResult }[],
  now: number,
  today: string,
): Promise<void> {
  // Never cache a failure. A rate limit is not a fact about a series.
  const storable = entries.filter(({ result }) => result.status !== 'error')
  if (storable.length === 0) return

  await db.batch(
    storable.map(({ key, result }) =>
      db
        .prepare(
          `INSERT INTO series_cache (cache_key, payload, fetched_at, has_unreleased)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(cache_key) DO UPDATE SET
             payload = excluded.payload,
             fetched_at = excluded.fetched_at,
             has_unreleased = excluded.has_unreleased`,
        )
        .bind(
          key,
          JSON.stringify(result),
          now,
          hasUnreleasedVolume(result, today) ? 1 : 0,
        ),
    ),
  )
}
