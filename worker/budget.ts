import type { D1Database } from './cache.ts'

/**
 * A daily budget for requests to Hardcover.
 *
 * Their free plan allows 5,000 requests a day, and their permission for this
 * deployment was "inside the API limits". The per-IP limiter and Turnstile
 * decide WHO may ask; neither bounds the total. This does: the Worker counts
 * the requests it really sends, per UTC day, and once the day's budget is
 * spent it stops resolving series nobody has looked up before. Cached series
 * cost nothing and keep working.
 *
 * It does not matter who is asking or from how many addresses — which is the
 * case a firewall rate limit could not cover on a workers.dev address anyway.
 */

/** Leaves 1,000 of Hardcover's 5,000 for retries, races and scripts/. */
export const DEFAULT_DAILY_BUDGET = 4000

/** What the reader is told; failureKind() in App.tsx looks for "daily". */
export const BUDGET_DETAIL = 'Daily lookup limit reached'

const CREATE = `CREATE TABLE IF NOT EXISTS upstream_budget (
  day TEXT PRIMARY KEY, calls INTEGER NOT NULL DEFAULT 0)`

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

export function budgetFrom(setting: string | undefined): number {
  const value = Number(setting)
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_DAILY_BUDGET
}

/**
 * Requests needed to resolve `count` uncached series when nothing is
 * retried: one search each, then two flat fetches per ten found (the links,
 * then the books). A batch with more than 250 books costs one more; the
 * meter counts what was really sent, this only decides what to attempt.
 */
export function costOf(count: number): number {
  return count === 0 ? 0 : count + 2 * Math.ceil(count / 10)
}

/** How many of `wanted` uncached series fit in what is left of the day. */
export function affordable(left: number, wanted: number): number {
  let count = Math.min(wanted, Math.max(0, left))
  while (count > 0 && costOf(count) > left) count -= 1
  return count
}

async function readSpent(db: D1Database, day: string): Promise<number> {
  const { results } = await db
    .prepare('SELECT calls FROM upstream_budget WHERE day = ?')
    .bind(day)
    .all<{ calls: number }>()
  return results[0]?.calls ?? 0
}

/** Requests already sent to Hardcover today. Creates the table on first use. */
export async function spentToday(db: D1Database, day: string): Promise<number> {
  try {
    return await readSpent(db, day)
  } catch {
    await db.prepare(CREATE).run()
    return readSpent(db, day)
  }
}

export async function recordSpend(db: D1Database, day: string, calls: number): Promise<void> {
  if (calls <= 0) return
  await db
    .prepare(
      `INSERT INTO upstream_budget (day, calls) VALUES (?, ?)
       ON CONFLICT(day) DO UPDATE SET calls = calls + excluded.calls`,
    )
    .bind(day, calls)
    .run()
}
