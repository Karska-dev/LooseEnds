import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  BUDGET_DETAIL,
  DEFAULT_DAILY_BUDGET,
  affordable,
  budgetFrom,
  costOf,
  recordSpend,
  spentToday,
  utcDay,
} from '../worker/budget.ts'
import { issuePass } from '../worker/pass.ts'
import worker from '../worker/index.ts'
import type { D1Database } from '../worker/cache.ts'

/** Just enough of D1: an empty series cache and one budget counter. */
function fakeDb(start: { calls?: number; table?: boolean } = {}) {
  const state = { calls: start.calls ?? 0, table: start.table ?? true, created: 0, writes: [] as number[] }
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...bound: unknown[]) => statement(sql, bound),
    async all<T>() {
      if (sql.includes('upstream_budget')) {
        if (!state.table) throw new Error('no such table: upstream_budget')
        return { results: (state.calls > 0 ? [{ calls: state.calls }] : []) as T[] }
      }
      return { results: [] as T[] }
    },
    async run() {
      if (sql.startsWith('CREATE TABLE')) {
        state.table = true
        state.created += 1
      } else if (sql.includes('upstream_budget')) {
        state.calls += values[1] as number
        state.writes.push(values[1] as number)
      }
      return {}
    },
  })
  const db: D1Database = { prepare: (sql) => statement(sql), batch: async () => ({}) }
  return { db, state }
}

describe('budget arithmetic', () => {
  test('a series costs its search plus a share of a five-series fetch', () => {
    assert.equal(costOf(1), 2)
    assert.equal(costOf(5), 6)
    assert.equal(costOf(10), 12)
  })

  test('affordable never spends past what is left', () => {
    assert.equal(affordable(100, 10), 10)
    assert.equal(affordable(12, 10), 10)
    assert.equal(affordable(11, 10), 9)
    assert.equal(affordable(2, 10), 1)
    assert.equal(affordable(1, 10), 0)
    assert.equal(affordable(0, 10), 0)
    assert.equal(affordable(-50, 10), 0)
    for (let left = 0; left < 40; left += 1) {
      assert.ok(costOf(affordable(left, 10)) <= left, `left=${left}`)
    }
  })

  test('the setting falls back to the default when missing or nonsense', () => {
    assert.equal(budgetFrom(undefined), DEFAULT_DAILY_BUDGET)
    assert.equal(budgetFrom('abc'), DEFAULT_DAILY_BUDGET)
    assert.equal(budgetFrom('-1'), DEFAULT_DAILY_BUDGET)
    assert.equal(budgetFrom('250'), 250)
    assert.equal(budgetFrom('0'), 0)
  })

  test('the day is the UTC day', () => {
    assert.equal(utcDay(Date.UTC(2026, 9, 1, 23, 59, 59)), '2026-10-01')
    assert.equal(utcDay(Date.UTC(2026, 9, 2, 0, 0, 0)), '2026-10-02')
  })
})

describe('the counter', () => {
  test('starts at zero and adds up', async () => {
    const { db } = fakeDb()
    assert.equal(await spentToday(db, '2026-10-01'), 0)
    await recordSpend(db, '2026-10-01', 12)
    await recordSpend(db, '2026-10-01', 3)
    await recordSpend(db, '2026-10-01', 0)
    assert.equal(await spentToday(db, '2026-10-01'), 15)
  })

  test('creates its table if the migration was never applied', async () => {
    const { db, state } = fakeDb({ table: false })
    assert.equal(await spentToday(db, '2026-10-01'), 0)
    assert.equal(state.created, 1)
  })
})

describe('the Worker', () => {
  const ORIGIN = 'https://looseends.example'
  const SECRET = 'test-secret'
  const lookup = async (db: D1Database, budget: string) => {
    const { pass } = await issuePass(SECRET, Date.now())
    const request = new Request(`${ORIGIN}/api/series`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-lookup-pass': pass },
      body: JSON.stringify({ series: [{ name: 'Dune' }, { name: 'Foundation' }] }),
    })
    const env = {
      HARDCOVER_TOKEN: '',
      ASSETS: { fetch: async () => new Response('') },
      DB: db,
      TURNSTILE_SECRET_KEY: SECRET,
      HARDCOVER_DAILY_BUDGET: budget,
    } as never
    return worker.fetch(request, env)
  }

  test('with the budget spent, new series are refused without calling Hardcover', async () => {
    const { db, state } = fakeDb({ calls: 4000 })
    // No Hardcover token is set: if the Worker tried to go upstream it would
    // answer 500 "not configured". A 200 proves it never tried.
    const response = await lookup(db, '4000')
    assert.equal(response.status, 200)
    const { results } = (await response.json()) as { results: { status: string; detail?: string }[] }
    assert.equal(results.length, 2)
    for (const result of results) {
      assert.equal(result.status, 'error')
      assert.equal(result.detail, BUDGET_DETAIL)
    }
    assert.deepEqual(state.writes, [], 'nothing was spent')
  })

  test('with budget left, the lookup goes upstream as before', async () => {
    const { db } = fakeDb({ calls: 10 })
    const response = await lookup(db, '4000')
    assert.equal(response.status, 500, 'reached the Hardcover step (no token in this test)')
  })
})
