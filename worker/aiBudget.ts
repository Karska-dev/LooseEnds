import type { D1Database } from './cache.ts'

/**
 * A daily allowance for the experimental AI lookup.
 *
 * Each new series costs one web search — now and then two — and one model
 * call. Both are free only up to a point: the search plan gives 1,000
 * searches a month, the model 10,000 neurons a day (a lookup is about 220).
 * The search is the tighter of the two: 1,000 a month is some 32 a day, so
 * the allowance is counted in searches and set just under that.
 *
 * Like the Hardcover budget (worker/budget.ts) it does not matter who is
 * asking: the count is for the whole deployment, per UTC day. Series someone
 * has already looked up are served from the cache and cost nothing.
 *
 * Algorithm: a fixed-window counter, the simplest rate limit there is. One
 * number per window (here a UTC day); a new day is a new row, so nothing
 * ever has to be reset. It is coarse: a whole day's allowance can go in its
 * first few minutes.
 */

/** Searches a day. 30 a day is 930 in the longest month, inside the 1,000. */
export const DEFAULT_AI_DAILY_BUDGET = 30

/** What the reader is told; failureKind() in App.tsx looks for "daily". */
export const AI_BUDGET_DETAIL = 'Daily AI lookup limit reached'

const CREATE = `CREATE TABLE IF NOT EXISTS ai_budget (
  day TEXT PRIMARY KEY, searches INTEGER NOT NULL DEFAULT 0)`

export function aiBudgetFrom(setting: string | undefined): number {
  const value = Number(setting)
  return setting !== undefined && setting !== '' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : DEFAULT_AI_DAILY_BUDGET
}

async function readSpent(db: D1Database, day: string): Promise<number> {
  const { results } = await db
    .prepare('SELECT searches FROM ai_budget WHERE day = ?')
    .bind(day)
    .all<{ searches: number }>()
  return results[0]?.searches ?? 0
}

/**
 * Searches already made today. Creates the table on first use.
 *
 * Pattern: lazy initialisation. Nothing is set up ahead of time; the first
 * read that finds the table missing makes it. A deploy then cannot fail
 * because a migration was forgotten.
 */
export async function aiSpentToday(db: D1Database, day: string): Promise<number> {
  try {
    return await readSpent(db, day)
  } catch {
    await db.prepare(CREATE).run()
    return readSpent(db, day)
  }
}

/**
 * Technique: an upsert (INSERT … ON CONFLICT DO UPDATE). One statement makes
 * the day's row or adds to it, and the database does the adding. Reading
 * the number, adding in code and writing it back would let two requests at
 * once overwrite each other's count (a lost update).
 */
export async function aiRecordSpend(db: D1Database, day: string, searches: number): Promise<void> {
  if (searches <= 0) return
  await db
    .prepare(
      `INSERT INTO ai_budget (day, searches) VALUES (?, ?)
       ON CONFLICT(day) DO UPDATE SET searches = searches + excluded.searches`,
    )
    .bind(day, searches)
    .run()
}
