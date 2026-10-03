import { aiLookupSeries } from '../src/shared/aiLookup.ts'
import type { AiSeriesResult } from '../src/shared/aiLookup.ts'
import { DEFAULT_AI_MODEL, LookupError, newAiMeter, tavilySearch, workersAiModel } from '../src/shared/aiProviders.ts'
import type { AiBinding } from '../src/shared/aiProviders.ts'
import type { SeriesQuery } from '../src/shared/hardcover.ts'
import { AI_BUDGET_DETAIL, aiBudgetFrom, aiRecordSpend, aiSpentToday } from './aiBudget.ts'
import { readAiCache, writeAiCache } from './aiCache.ts'
import { cacheKey } from './cache.ts'
import type { D1Database } from './cache.ts'
import { json, log } from './http.ts'

/**
 * POST /api/ai-series — the experimental AI lookup.
 *
 * The same request shape as /api/series, and the same result shape back with
 * a few fields added, so the board can read either. Nothing else is shared:
 * its own cache table, its own allowance, and no fallback to or from
 * Hardcover in either direction.
 *
 * One series per request. A lookup is a web search and a model call — ten
 * seconds or more — so the page asks for them one at a time and shows each
 * as it arrives.
 */

export interface AiEnv {
  DB?: D1Database
  /** Tavily API key (`wrangler secret put TAVILY_KEY`). */
  TAVILY_KEY?: string
  /** The Workers AI binding ("ai": { "binding": "AI" } in wrangler.jsonc). */
  AI?: AiBinding
  /** Web searches allowed per UTC day; see worker/aiBudget.ts. */
  AI_DAILY_BUDGET?: string
  /** Which Workers AI model reads the pages. Must support JSON mode. */
  AI_MODEL?: string
}

const MAX_AI_SERIES = 1
/** A cache-only request is one D1 query: the whole library in one go. */
const MAX_AI_CACHED_ONLY = 200

/** Said when the month's searches are gone. Not "daily": tomorrow will not help. */
export const AI_MONTH_DETAIL = 'AI lookup is out of searches for this month'
export const AI_UNSET_DETAIL = 'AI lookup is not configured on this server'
export const AI_UNREACHABLE_DETAIL = 'AI lookup could not be reached'

/** A lookup that could not be made, in the shape of a result. Never cached. */
export function aiFailure(query: SeriesQuery, detail: string, today: string): AiSeriesResult {
  return {
    query: query.name,
    matchedName: null,
    hardcoverId: null,
    totalBooks: null,
    volumes: [],
    status: 'error',
    detail,
    source: 'ai',
    checkedAt: today,
  }
}

/**
 * What the page is told when a lookup fails. The page reads these exact
 * strings to decide what to say and whether to keep asking, so the dev
 * server (vite.config.ts) uses this too.
 */
export function failureDetail(error: unknown): string {
  const kind = error instanceof LookupError ? error.kind : 'busy'
  if (kind === 'limit') return AI_BUDGET_DETAIL
  if (kind === 'month') return AI_MONTH_DETAIL
  if (kind === 'key') return AI_UNSET_DETAIL
  return AI_UNREACHABLE_DETAIL
}

function isSeriesQueryList(value: unknown): value is SeriesQuery[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as SeriesQuery).name === 'string' &&
        (item as SeriesQuery).name.trim().length > 0 &&
        ((item as SeriesQuery).author === undefined || typeof (item as SeriesQuery).author === 'string'),
    )
  )
}

export async function handleAiSeries(request: Request, env: AiEnv): Promise<Response> {
  const started = Date.now()

  let series: unknown
  let cachedOnly = false
  try {
    const body = (await request.json()) as { series?: unknown; cachedOnly?: unknown }
    series = body.series
    cachedOnly = body.cachedOnly === true
  } catch {
    log('ai.bad_request', { status: 400, reason: 'body was not JSON' })
    return json({ error: 'Send a JSON body with a "series" array.' }, 400)
  }
  if (!isSeriesQueryList(series)) {
    log('ai.bad_request', { status: 400, reason: 'entries missing a name' })
    return json({ error: 'Each entry needs a "name", and may have an "author".' }, 400)
  }
  const limit = cachedOnly ? MAX_AI_CACHED_ONLY : MAX_AI_SERIES
  if (series.length === 0 || series.length > limit) {
    log('ai.bad_request', { status: 400, reason: 'batch size', size: series.length })
    return json(
      { error: cachedOnly ? `Send between 1 and ${limit} series.` : 'Send one series at a time.' },
      400,
    )
  }

  const now = Date.now()
  const today = new Date(now).toISOString().slice(0, 10)
  const model = env.AI_MODEL || DEFAULT_AI_MODEL

  try {
    const keys = series.map((item) => cacheKey(item.name, item.author))
    const cached = env.DB ? await readAiCache(env.DB, keys, now) : new Map<string, AiSeriesResult>()
    if (!env.DB) log('ai.cache_unavailable', { expected: 'DB' })

    // A cached answer is given back under the name it was asked for now:
    // two spellings can share one cache key.
    const fromCache = (index: number): AiSeriesResult | null => {
      const hit = cached.get(keys[index])
      return hit ? { ...hit, query: series[index].name } : null
    }

    if (cachedOnly) {
      const results = series.flatMap((_, index) => fromCache(index) ?? [])
      log('ai.resolved', { status: 200, cachedOnly, requested: series.length, cacheHits: results.length, ms: Date.now() - started })
      return json({ results })
    }

    const query = series[0]
    const hit = fromCache(0)
    if (hit) {
      log('ai.resolved', { status: 200, cachedOnly, requested: 1, cacheHits: 1, result: hit.status, ms: Date.now() - started })
      return json({ results: [hit] })
    }

    if (!env.TAVILY_KEY || !env.AI) {
      log('ai.misconfigured', { status: 500, tavilyKey: Boolean(env.TAVILY_KEY), ai: Boolean(env.AI) })
      return json({ error: `${AI_UNSET_DETAIL}.` }, 500)
    }

    // The daily allowance. If the count cannot be read, look up anyway and
    // say so in the log: a broken counter must not take the lookup down, and
    // the search and the model each stop on their own when their free
    // allowance is gone.
    const cap = aiBudgetFrom(env.AI_DAILY_BUDGET)
    let spent: number | null = null
    if (env.DB) {
      try {
        spent = await aiSpentToday(env.DB, today)
      } catch (error) {
        log('ai.budget_unavailable', { message: error instanceof Error ? error.message : String(error) })
      }
    }
    if (spent !== null && spent >= cap) {
      log('ai.budget_exhausted', { status: 200, cap, spent })
      return json({ results: [aiFailure(query, AI_BUDGET_DETAIL, today)] })
    }

    const meter = newAiMeter()
    let result: AiSeriesResult
    let kept = 0
    let dropped = 0
    let failure: string | null = null
    try {
      const outcome = await aiLookupSeries(query, {
        today,
        search: tavilySearch(env.TAVILY_KEY, meter),
        runModel: workersAiModel(env.AI, model, meter),
      })
      result = outcome.result
      kept = outcome.report.kept
      dropped = outcome.report.dropped.length
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      result = aiFailure(query, failureDetail(error), today)
    }

    // Count what was really sent, whatever came of it.
    if (env.DB && meter.searches > 0) {
      try {
        await aiRecordSpend(env.DB, today, meter.searches)
      } catch (error) {
        log('ai.budget_unavailable', { message: error instanceof Error ? error.message : String(error) })
      }
    }

    const cacheWriteError = env.DB ? await writeAiCache(env.DB, keys[0], result, model, now, today) : null

    log('ai.resolved', {
      status: 200,
      cachedOnly,
      requested: 1,
      cacheHits: 0,
      result: result.status,
      detail: result.detail ?? null,
      failure,
      kept,
      dropped,
      model,
      searches: meter.searches,
      credits: meter.credits,
      inputTokens: meter.inputTokens,
      outputTokens: meter.outputTokens,
      budgetSpent: spent === null ? null : spent + meter.searches,
      budgetCap: cap,
      cacheWriteError,
      sampleKey: keys[0],
      ms: Date.now() - started,
    })
    return json({ results: [result] })
  } catch (error) {
    log('ai.unhandled', {
      status: 500,
      ms: Date.now() - started,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack?.slice(0, 600) : undefined,
    })
    return json({ error: 'AI lookup failed unexpectedly.' }, 500)
  }
}
