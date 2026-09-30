import type { SeriesResult, Volume } from '../src/shared/hardcover'

/** Minimal shape of the D1 binding, so we need no extra dependency. */
interface D1PreparedStatement {
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

/** An audiobook still to come is news too: re-check it daily, like a book. */
function audioPending(volume: Volume, today: string): boolean {
  return volume.editions.some((edition) => (edition.audioDate ?? '') > today)
}

export function hasUnreleasedVolume(result: SeriesResult, today: string): boolean {
  return result.volumes.some((volume) => !volumeReleased(volume, today) || audioPending(volume, today))
}

/**
 * Written before audiobook dates were fetched. Treated as a miss so each
 * series is fetched once more when someone next asks for it, rather than
 * waiting out a thirty-day TTL — or evicting the whole cache at once.
 */
export function predatesAudioDates(result: SeriesResult): boolean {
  return result.volumes.some((volume) => volume.editions.some((edition) => !('hasAudio' in edition)))
}

interface CacheLookup {
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
      const result = JSON.parse(row.payload) as SeriesResult
      if (predatesAudioDates(result)) continue
      hits.set(row.cache_key, result)
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
): Promise<{ attempted: number; error: string | null }> {
  // Never cache a failure. A rate limit is not a fact about a series.
  const storable = entries.filter(({ result }) => result.status !== 'error')
  if (storable.length === 0) return { attempted: 0, error: null }

  try {
    await writeBatch(db, storable, now, today)
    return { attempted: storable.length, error: null }
  } catch (error) {
    return {
      attempted: storable.length,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function writeBatch(
  db: D1Database,
  storable: { key: string; result: SeriesResult }[],
  now: number,
  today: string,
): Promise<void> {
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
