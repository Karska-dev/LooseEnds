import { TOO_FEW_BOOKS } from '../src/shared/aiLookup.ts'
import type { AiSeriesResult } from '../src/shared/aiLookup.ts'
import type { D1Database } from './cache.ts'

/**
 * The AI lookup's own cache. It is a separate table from series_cache on
 * purpose: what a model read off the web must never be served as, mixed
 * with, or overwritten by what Hardcover's librarians entered.
 *
 * Every row carries its own expiry, decided when it is written. A lookup
 * here costs a share of a small daily allowance, so answers are kept longer
 * than Hardcover's — and a miss is kept too, because finding nothing costs
 * exactly as much as finding something.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** Every book has a date in the past: the list will not change soon. */
const SETTLED_MS = 90 * DAY_MS
/** A book is announced, or has no date: that is the news readers wait for. */
const PENDING_MS = 7 * DAY_MS
/** Pages about the series did not yield one. Worth another look, not daily. */
const NOT_FOUND_MS = 14 * DAY_MS
/**
 * The search came back empty or about something else, or the model's reply
 * could not be read: a bad moment, not a fact about the series. Ask again
 * tomorrow.
 */
const BAD_MOMENT_MS = DAY_MS

const CREATE = `CREATE TABLE IF NOT EXISTS ai_series_cache (
  cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, status TEXT NOT NULL, model TEXT NOT NULL)`

/** How long an answer stays good. Never called for a failure: those are not kept. */
export function maxAgeFor(result: AiSeriesResult, today: string): number {
  if (result.status !== 'ok') return result.detail === TOO_FEW_BOOKS ? NOT_FOUND_MS : BAD_MOMENT_MS
  const open = result.volumes.some((volume) => {
    const edition = volume.editions[0]
    if (!edition) return true
    if (edition.releaseDate === null) return !edition.releasedInferred
    return edition.releaseDate > today
  })
  return open ? PENDING_MS : SETTLED_MS
}

interface Row {
  cache_key: string
  payload: string
}

async function select(db: D1Database, keys: string[], now: number): Promise<Row[]> {
  const placeholders = keys.map(() => '?').join(',')
  const { results } = await db
    .prepare(`SELECT cache_key, payload FROM ai_series_cache WHERE expires_at > ? AND cache_key IN (${placeholders})`)
    .bind(now, ...keys)
    .all<Row>()
  return results
}

export async function readAiCache(
  db: D1Database,
  keys: string[],
  now: number,
): Promise<Map<string, AiSeriesResult>> {
  const hits = new Map<string, AiSeriesResult>()
  if (keys.length === 0) return hits
  let rows: Row[]
  try {
    rows = await select(db, keys, now)
  } catch {
    // The migration was never applied: make the table and read nothing.
    await db.prepare(CREATE).run()
    rows = []
  }
  for (const row of rows) {
    try {
      hits.set(row.cache_key, JSON.parse(row.payload) as AiSeriesResult)
    } catch {
      // A corrupt row is a miss; the next lookup replaces it.
    }
  }
  return hits
}

export async function writeAiCache(
  db: D1Database,
  key: string,
  result: AiSeriesResult,
  model: string,
  now: number,
  today: string,
): Promise<string | null> {
  // A failure is not a fact about a series.
  if (result.status === 'error') return null
  try {
    await db
      .prepare(
        `INSERT INTO ai_series_cache (cache_key, payload, fetched_at, expires_at, status, model)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           payload = excluded.payload,
           fetched_at = excluded.fetched_at,
           expires_at = excluded.expires_at,
           status = excluded.status,
           model = excluded.model`,
      )
      .bind(key, JSON.stringify(result), now, now + maxAgeFor(result, today), result.status, model)
      .run()
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
