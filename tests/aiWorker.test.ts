import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { NOTHING_RELEVANT, TOO_FEW_BOOKS } from '../src/shared/aiLookup.ts'
import type { AiSeriesResult } from '../src/shared/aiLookup.ts'
import { AI_MONTH_DETAIL } from '../worker/ai.ts'
import { AI_BUDGET_DETAIL, DEFAULT_AI_DAILY_BUDGET, aiBudgetFrom, aiRecordSpend, aiSpentToday } from '../worker/aiBudget.ts'
import { maxAgeFor, readAiCache, writeAiCache } from '../worker/aiCache.ts'
import { issuePass } from '../worker/pass.ts'
import worker from '../worker/index.ts'
import type { D1Database } from '../worker/cache.ts'

const DAY = 24 * 60 * 60 * 1000

/** Just enough of D1 for the AI lookup: its cache table and its counter. */
function fakeDb(start: { searches?: number; tables?: boolean } = {}) {
  const state = {
    tables: start.tables ?? true,
    created: 0,
    searches: start.searches ?? 0,
    spends: [] as number[],
    rows: new Map<string, { payload: string; expires: number; status: string; model: string }>(),
  }
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...bound: unknown[]) => statement(sql, bound),
    async all<T>() {
      if (sql.includes('FROM ai_series_cache')) {
        if (!state.tables) throw new Error('no such table: ai_series_cache')
        const [now, ...keys] = values as [number, ...string[]]
        return {
          results: keys.flatMap((key) => {
            const row = state.rows.get(key)
            return row && row.expires > now ? [{ cache_key: key, payload: row.payload }] : []
          }) as T[],
        }
      }
      if (sql.includes('FROM ai_budget')) {
        if (!state.tables) throw new Error('no such table: ai_budget')
        return { results: (state.searches > 0 ? [{ searches: state.searches }] : []) as T[] }
      }
      return { results: [] as T[] }
    },
    async run() {
      if (sql.startsWith('CREATE TABLE')) {
        state.tables = true
        state.created += 1
      } else if (sql.includes('INTO ai_series_cache')) {
        const [key, payload, , expires, status, model] = values as [string, string, number, number, string, string]
        state.rows.set(key, { payload, expires, status, model })
      } else if (sql.includes('INTO ai_budget')) {
        state.searches += values[1] as number
        state.spends.push(values[1] as number)
      }
      return {}
    },
  })
  const db: D1Database = { prepare: (sql) => statement(sql), batch: async () => ({}) }
  return { db, state }
}

function found(dates: (string | null)[], extra: Partial<AiSeriesResult> = {}): AiSeriesResult {
  return {
    query: 'The Hollow Crown',
    matchedName: 'The Hollow Crown',
    hardcoverId: null,
    totalBooks: dates.length,
    status: 'ok',
    source: 'ai',
    checkedAt: '2026-10-03',
    volumes: dates.map((releaseDate, index) => ({
      position: index + 1,
      editions: [{ title: `Book ${index + 1}`, releaseDate, languageId: null, readers: 0, coverUrl: null, coverColor: null, slug: null }],
      evidence: { url: 'https://author.example', dateVerified: releaseDate !== null, positionFrom: 'pages' },
    })),
    ...extra,
  }
}

describe('how long an AI answer is kept', () => {
  const today = '2026-10-03'

  test('a finished list: ninety days', () => {
    assert.equal(maxAgeFor(found(['2021', '2022-10-12']), today), 90 * DAY)
  })

  test('an announced book, or one with no date: a week', () => {
    assert.equal(maxAgeFor(found(['2021', '2027-02-09']), today), 7 * DAY)
    assert.equal(maxAgeFor(found(['2021', null]), today), 7 * DAY)
  })

  test('an undated book that must be out, because a later one is, does not keep it open', () => {
    const result = found([null, '2022'])
    result.volumes[0].editions[0].releasedInferred = true
    assert.equal(maxAgeFor(result, today), 90 * DAY)
  })

  test('nothing found on pages about the series: two weeks', () => {
    const miss = { ...found([]), status: 'not_found' as const, detail: TOO_FEW_BOOKS }
    assert.equal(maxAgeFor(miss, today), 14 * DAY)
  })

  test('the search or the model having a bad moment: a day', () => {
    const miss = { ...found([]), status: 'not_found' as const }
    assert.equal(maxAgeFor({ ...miss, detail: NOTHING_RELEVANT }, today), DAY)
    assert.equal(maxAgeFor({ ...miss, detail: 'no pages with text' }, today), DAY)
    assert.equal(maxAgeFor({ ...miss, detail: 'model reply was not the JSON asked for' }, today), DAY)
  })
})

describe('the AI cache', () => {
  test('gives back what was written, until it expires', async () => {
    const { db } = fakeDb()
    const now = Date.UTC(2026, 9, 3)
    assert.equal(await writeAiCache(db, 'hollow crown', found(['2021', '2022']), 'model-a', now, '2026-10-03'), null)
    assert.equal((await readAiCache(db, ['hollow crown'], now + 89 * DAY)).size, 1)
    assert.equal((await readAiCache(db, ['hollow crown'], now + 91 * DAY)).size, 0)
  })

  test('never keeps a failure', async () => {
    const { db, state } = fakeDb()
    const failure = { ...found([]), status: 'error' as const, detail: AI_BUDGET_DETAIL }
    await writeAiCache(db, 'hollow crown', failure, 'model-a', 0, '2026-10-03')
    assert.equal(state.rows.size, 0)
  })

  test('creates its table if the migration was never applied', async () => {
    const { db, state } = fakeDb({ tables: false })
    assert.equal((await readAiCache(db, ['x'], 0)).size, 0)
    assert.equal(state.created, 1)
  })
})

describe('the AI allowance', () => {
  test('the setting falls back to the default when missing or nonsense', () => {
    assert.equal(aiBudgetFrom(undefined), DEFAULT_AI_DAILY_BUDGET)
    assert.equal(aiBudgetFrom(''), DEFAULT_AI_DAILY_BUDGET)
    assert.equal(aiBudgetFrom('many'), DEFAULT_AI_DAILY_BUDGET)
    assert.equal(aiBudgetFrom('-3'), DEFAULT_AI_DAILY_BUDGET)
    assert.equal(aiBudgetFrom('12'), 12)
    assert.equal(aiBudgetFrom('0'), 0)
  })

  test('starts at zero, adds up, and makes its own table', async () => {
    const { db, state } = fakeDb({ tables: false })
    assert.equal(await aiSpentToday(db, '2026-10-03'), 0)
    assert.equal(state.created, 1)
    await aiRecordSpend(db, '2026-10-03', 1)
    await aiRecordSpend(db, '2026-10-03', 2)
    await aiRecordSpend(db, '2026-10-03', 0)
    assert.equal(await aiSpentToday(db, '2026-10-03'), 3)
  })
})

describe('POST /api/ai-series', () => {
  const ORIGIN = 'https://looseends.example'
  const SECRET = 'test-secret'
  const QUERY = { name: 'The Hollow Crown', author: 'A. N. Author' }

  const AUTHOR_PAGE = {
    url: 'https://author.example/hollow-crown',
    title: 'The Hollow Crown series',
    content: 'The Hollow Crown: 1. A Throne of Ash (2021) 2. A Crown of Salt (2022)',
    raw_content: '# The Hollow Crown\n\n1. A Throne of Ash (2021)\n2. A Crown of Salt (2022)\n3. A Reign of Glass (2027)',
    score: 0.9,
  }
  const UNRELATED = { url: 'https://dictionary.example/hollow', title: 'hollow', content: 'hollow: empty inside', raw_content: null, score: 0.04 }
  const DRAFT = {
    seriesName: 'The Hollow Crown',
    readingOrder: null,
    books: [
      { title: 'A Throne of Ash', position: 1, releaseDate: '2021', source: 'P1', audiobook: null },
      { title: 'A Crown of Salt', position: 2, releaseDate: '2022', source: 'P1', audiobook: null },
      { title: 'A Reign of Glass', position: 3, releaseDate: '2027', source: 'P1', audiobook: null },
      { title: 'A Dynasty of Thorns', position: 4, releaseDate: '2029', source: 'P1', audiobook: null },
    ],
  }

  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  /** Stands in for Tavily: answers each search with the next response given. */
  function searchReturns(...responses: (Response | (() => Response))[]) {
    const asked: string[] = []
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      asked.push((JSON.parse(String(init?.body)) as { query: string }).query)
      const next = responses[Math.min(asked.length - 1, responses.length - 1)]
      return typeof next === 'function' ? next() : next.clone()
    }) as typeof fetch
    return asked
  }
  const pages = (...results: unknown[]) => () => Response.json({ results, usage: { credits: 1 } })

  function model(reply: unknown = DRAFT) {
    const calls: unknown[] = []
    return {
      calls,
      binding: {
        run: async (_model: string, input: unknown) => {
          calls.push(input)
          if (reply instanceof Error) throw reply
          return { response: reply, usage: { prompt_tokens: 1200, completion_tokens: 150 } }
        },
      },
    }
  }

  async function ask(
    db: D1Database | undefined,
    body: unknown,
    options: { ai?: unknown; key?: string; budget?: string; headers?: Record<string, string>; method?: string } = {},
  ) {
    const { pass } = await issuePass(SECRET, Date.now())
    const request = new Request(`${ORIGIN}/api/ai-series`, {
      method: options.method ?? 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-lookup-pass': pass, ...options.headers },
      body: options.method === 'GET' ? undefined : JSON.stringify(body),
    })
    const env = {
      HARDCOVER_TOKEN: '',
      ASSETS: { fetch: async () => new Response('') },
      DB: db,
      TURNSTILE_SECRET_KEY: SECRET,
      TAVILY_KEY: 'key' in options ? options.key : 'tvly-test',
      AI: 'ai' in options ? options.ai : model().binding,
      AI_DAILY_BUDGET: options.budget ?? '30',
    } as never
    return worker.fetch(request, env)
  }
  const resultsOf = async (response: Response) => ((await response.json()) as { results: AiSeriesResult[] }).results

  test('stands behind the same door as /api/series', async () => {
    const { db } = fakeDb()
    const asked = searchReturns(pages(AUTHOR_PAGE))
    assert.equal((await ask(db, { series: [QUERY] }, { method: 'GET' })).status, 405)
    assert.equal((await ask(db, { series: [QUERY] }, { headers: { origin: 'https://elsewhere.example' } })).status, 403)
    assert.equal((await ask(db, { series: [QUERY] }, { headers: { 'x-lookup-pass': 'forged' } })).status, 401)
    assert.deepEqual(asked, [], 'nothing was searched for a refused request')
  })

  test('looks a series up, keeps only what the page says, and remembers it', async () => {
    const { db, state } = fakeDb()
    const asked = searchReturns(pages(AUTHOR_PAGE))
    const ai = model()

    const [result] = await resultsOf(await ask(db, { series: [QUERY] }, { ai: ai.binding }))
    assert.equal(result.status, 'ok')
    assert.equal(result.source, 'ai')
    assert.equal(result.query, 'The Hollow Crown')
    assert.deepEqual(
      result.volumes.map((volume) => [volume.position, volume.editions[0].title, volume.editions[0].releaseDate]),
      [
        [1, 'A Throne of Ash', '2021'],
        [2, 'A Crown of Salt', '2022'],
        [3, 'A Reign of Glass', '2027'],
      ],
      'the fourth book the model made up is not on the page, and is gone',
    )
    assert.equal(asked.length, 1)
    assert.equal(ai.calls.length, 1)
    assert.deepEqual(state.spends, [1], 'one search counted against the day')
    assert.equal(state.rows.size, 1)

    // The same series again, asked by anyone: no search, no model, no cost.
    const [again] = await resultsOf(await ask(db, { series: [QUERY] }, { ai: ai.binding }))
    assert.equal(again.status, 'ok')
    assert.equal(asked.length, 1)
    assert.equal(ai.calls.length, 1)
    assert.deepEqual(state.spends, [1])
  })

  test('a cache-only request answers with what is known and looks nothing up', async () => {
    const { db } = fakeDb()
    const asked = searchReturns(pages(AUTHOR_PAGE))
    await ask(db, { series: [QUERY] })

    const response = await ask(db, { series: [QUERY, { name: 'Never Looked Up' }], cachedOnly: true })
    const results = await resultsOf(response)
    assert.equal(results.length, 1)
    assert.equal(results[0].query, 'The Hollow Crown')
    assert.equal(asked.length, 1, 'only the first, real lookup searched')
  })

  test('one series at a time', async () => {
    const { db } = fakeDb()
    const response = await ask(db, { series: [QUERY, { name: 'Another' }] })
    assert.equal(response.status, 400)
  })

  test('with the allowance spent, a new series is refused without searching', async () => {
    const { db, state } = fakeDb({ searches: 30 })
    const asked = searchReturns(pages(AUTHOR_PAGE))
    const [result] = await resultsOf(await ask(db, { series: [QUERY] }, { budget: '30' }))
    assert.equal(result.status, 'error')
    assert.equal(result.detail, AI_BUDGET_DETAIL)
    assert.deepEqual(asked, [])
    assert.deepEqual(state.spends, [])
    assert.equal(state.rows.size, 0, 'being out of allowance is not a fact about the series')
  })

  test('with the allowance spent, a series already looked up still answers', async () => {
    const { db, state } = fakeDb()
    searchReturns(pages(AUTHOR_PAGE))
    await ask(db, { series: [QUERY] })
    state.searches = 30
    const [result] = await resultsOf(await ask(db, { series: [QUERY] }, { budget: '30' }))
    assert.equal(result.status, 'ok')
  })

  test('a search that comes back about something else is asked once more; twice wrong is a one-day miss', async () => {
    const { db, state } = fakeDb()
    const asked = searchReturns(pages(UNRELATED))
    const ai = model()
    const before = Date.now()

    const [result] = await resultsOf(await ask(db, { series: [QUERY] }, { ai: ai.binding }))
    assert.equal(result.status, 'not_found')
    assert.equal(result.detail, NOTHING_RELEVANT)
    assert.equal(asked.length, 2)
    assert.equal(ai.calls.length, 0, 'the model is never shown pages about something else')
    assert.deepEqual(state.spends, [2])
    const row = [...state.rows.values()][0]
    assert.ok(row.expires - before <= DAY + 5000 && row.expires - before >= DAY - 5000, 'kept for a day')
  })

  test('the second, differently worded search rescues the lookup', async () => {
    const { db } = fakeDb()
    const asked = searchReturns(pages(UNRELATED), pages(AUTHOR_PAGE))
    const [result] = await resultsOf(await ask(db, { series: [QUERY] }))
    assert.equal(result.status, 'ok')
    assert.equal(asked.length, 2)
    assert.notEqual(asked[0], asked[1])
  })

  test('the month\'s searches used up: said plainly, and not remembered', async () => {
    const { db, state } = fakeDb()
    searchReturns(new Response('{"detail":"limit"}', { status: 432 }))
    const [result] = await resultsOf(await ask(db, { series: [QUERY] }))
    assert.equal(result.status, 'error')
    assert.equal(result.detail, AI_MONTH_DETAIL)
    assert.equal(state.rows.size, 0)
  })

  test('the model failing is a failure, not a missing series', async () => {
    const { db, state } = fakeDb()
    searchReturns(pages(AUTHOR_PAGE))
    const ai = model(new Error('upstream timeout'))
    const [result] = await resultsOf(await ask(db, { series: [QUERY] }, { ai: ai.binding }))
    assert.equal(result.status, 'error')
    assert.match(result.detail ?? '', /could not be reached/)
    assert.equal(state.rows.size, 0)
    assert.deepEqual(state.spends, [1], 'the search was still made, and is still counted')
  })

  test('the model\'s own daily limit reads as the daily limit', async () => {
    const { db } = fakeDb()
    searchReturns(pages(AUTHOR_PAGE))
    const ai = model(new Error('4006: you have used up your daily free allocation of 10,000 neurons'))
    const [result] = await resultsOf(await ask(db, { series: [QUERY] }, { ai: ai.binding }))
    assert.equal(result.detail, AI_BUDGET_DETAIL)
  })

  test('no search key or no model binding: not configured, and nothing is attempted', async () => {
    const { db } = fakeDb()
    const asked = searchReturns(pages(AUTHOR_PAGE))
    assert.equal((await ask(db, { series: [QUERY] }, { key: undefined })).status, 500)
    assert.equal((await ask(db, { series: [QUERY] }, { ai: undefined })).status, 500)
    assert.deepEqual(asked, [])
  })

  test('a broken counter does not take the lookup down', async () => {
    const { db } = fakeDb()
    const broken: D1Database = {
      ...db,
      prepare: (sql) => {
        if (sql.includes('ai_budget')) throw new Error('D1 is having a moment')
        return db.prepare(sql)
      },
    }
    searchReturns(pages(AUTHOR_PAGE))
    const [result] = await resultsOf(await ask(broken, { series: [QUERY] }))
    assert.equal(result.status, 'ok')
  })

  test('without a database it still looks up, just without remembering', async () => {
    const asked = searchReturns(pages(AUTHOR_PAGE))
    const [result] = await resultsOf(await ask(undefined, { series: [QUERY] }))
    assert.equal(result.status, 'ok')
    assert.equal(asked.length, 1)
  })
})
