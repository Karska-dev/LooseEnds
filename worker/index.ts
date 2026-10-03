import { resolveSeriesNames } from '../src/shared/hardcover.ts'
import type { SeriesQuery, SeriesResult } from '../src/shared/hardcover.ts'
import { cacheKey, readCache, writeCache } from './cache.ts'
import type { D1Database } from './cache.ts'
import { claimedOrigin, isSameOrigin } from './origin.ts'
import { checkPass, issuePass, verifyTurnstile } from './pass.ts'
import { BUDGET_DETAIL, affordable, budgetFrom, recordSpend, spentToday } from './budget.ts'
import { handleAiSeries } from './ai.ts'
import type { AiEnv } from './ai.ts'
import { json, log } from './http.ts'

type Limiter = { limit(options: { key: string }): Promise<{ success: boolean }> }

interface Env extends AiEnv {
  HARDCOVER_TOKEN: string
  /** Static asset binding: the built Vite output. */
  ASSETS: { fetch(request: Request): Promise<Response> }
  /** Absent in local development, where the cache is simply skipped. */
  DB?: D1Database
  /** Absent in local development, where throttling is skipped. */
  SERIES_LIMITER?: Limiter
  /** A tighter throttle for /api/ai-series, where every miss costs allowance. */
  AI_LIMITER?: Limiter
  /** Turnstile widget's public site key (a plain var in wrangler.jsonc). */
  TURNSTILE_SITE_KEY?: string
  /** Turnstile secret (`wrangler secret put`). Also derives the pass-signing key. */
  TURNSTILE_SECRET_KEY?: string
  /** Requests to Hardcover allowed per UTC day; see worker/budget.ts. */
  HARDCOVER_DAILY_BUDGET?: string
}

/** Keep each request well inside the Worker's subrequest budget. */
const MAX_SERIES = 10

/**
 * A cache-only request makes one D1 query and no upstream calls, so the batch
 * can be far larger. This is what makes a warm library load in one round trip
 * instead of one per ten series.
 */
const MAX_CACHED_ONLY = 200

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api/pass') {
      return handlePass(request, env, url)
    }

    if (url.pathname === '/api/series') {
      return (await refuse(request, env, env.SERIES_LIMITER, 'series')) ?? handleSeries(request, env)
    }

    // The experimental AI lookup: the same door, its own throttle.
    if (url.pathname === '/api/ai-series') {
      return (await refuse(request, env, env.AI_LIMITER, 'ai')) ?? handleAiSeries(request, env)
    }

    // Everything else is the built single-page app.
    return env.ASSETS.fetch(request)
  },
}

/**
 * What stands in front of both lookups, cheapest check first: the method,
 * that the request came from our own page, a live lookup pass, and the
 * per-IP throttle. Returns the refusal, or null to go ahead.
 */
async function refuse(
  request: Request,
  env: Env,
  limiter: Limiter | undefined,
  event: 'series' | 'ai',
): Promise<Response | null> {
  if (request.method !== 'POST') {
    return json({ error: 'Use POST with a JSON body.' }, 405)
  }

  // Before the limiter, so a refused caller costs nothing and does not
  // use up anyone's allowance.
  if (!isSameOrigin(request)) {
    log(`${event}.forbidden_origin`, { status: 403, origin: claimedOrigin(request) })
    return json({ error: 'Lookups only work from the Loose Ends page itself.' }, 403)
  }

  // Also before the limiter: a request without a live pass is refused
  // for free. Without the secret nothing can be checked, so nothing is
  // answered — an unconfigured deploy must fail closed, not open.
  if (!env.TURNSTILE_SECRET_KEY) {
    log(`${event}.misconfigured`, { status: 500, reason: 'TURNSTILE_SECRET_KEY missing' })
    return json({ error: 'Lookup protection is not configured on this server.' }, 500)
  }
  if (!(await checkPass(request.headers.get('x-lookup-pass'), env.TURNSTILE_SECRET_KEY, Date.now()))) {
    log(`${event}.no_pass`, { status: 401 })
    return json({ error: 'The lookup pass is missing or expired.', code: 'pass' }, 401)
  }

  // Keyed by caller IP, not by path: the point is to stop one client
  // exhausting the upstream allowance, not to cap the endpoint overall.
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  if (limiter) {
    const { success } = await limiter.limit({ key: ip })
    if (!success) {
      log(`${event}.rate_limited`, { status: 429 })
      return json(
        { error: 'Too many lookups just now. Wait a minute and try again.' },
        429,
        { 'retry-after': '60' },
      )
    }
  }
  return null
}

/**
 * GET  → the public site key, so the page needs no build-time setting.
 * POST → spends one Turnstile token on a lookup pass (see worker/pass.ts).
 */
async function handlePass(request: Request, env: Env, url: URL): Promise<Response> {
  const noStore = { 'cache-control': 'no-store' }

  if (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY) {
    log('pass.misconfigured', {
      status: 500,
      siteKey: Boolean(env.TURNSTILE_SITE_KEY),
      secret: Boolean(env.TURNSTILE_SECRET_KEY),
    })
    return json({ error: 'Lookup protection is not configured on this server.' }, 500, noStore)
  }

  if (request.method === 'GET') {
    return json({ siteKey: env.TURNSTILE_SITE_KEY }, 200, noStore)
  }
  if (request.method !== 'POST') {
    return json({ error: 'Use GET or POST.' }, 405, noStore)
  }

  if (!isSameOrigin(request)) {
    log('pass.forbidden_origin', { status: 403, origin: claimedOrigin(request) })
    return json({ error: 'Lookups only work from the Loose Ends page itself.' }, 403, noStore)
  }

  const ip = request.headers.get('CF-Connecting-IP')
  if (env.SERIES_LIMITER) {
    const { success } = await env.SERIES_LIMITER.limit({ key: ip ?? 'unknown' })
    if (!success) {
      log('pass.rate_limited', { status: 429 })
      return json({ error: 'Too many lookups just now. Wait a minute and try again.' }, 429, {
        ...noStore,
        'retry-after': '60',
      })
    }
  }

  let token = ''
  try {
    const body = (await request.json()) as { token?: unknown }
    if (typeof body.token === 'string') token = body.token
  } catch {
    // Falls through to the empty-token refusal below.
  }
  if (!token || token.length > 2048) {
    log('pass.bad_request', { status: 400 })
    return json({ error: 'Send the Turnstile token as {"token": "…"}.' }, 400, noStore)
  }

  const outcome = await verifyTurnstile(token, env.TURNSTILE_SECRET_KEY, { ip, hostname: url.hostname })
  if (!outcome.ok) {
    log('pass.refused', { status: 403, codes: outcome.codes })
    return json(
      { error: 'Couldn’t confirm you’re a person. Try again.', code: 'turnstile' },
      403,
      noStore,
    )
  }

  const issued = await issuePass(env.TURNSTILE_SECRET_KEY, Date.now())
  log('pass.issued', { status: 200 })
  return json(issued, 200, noStore)
}

async function handleSeries(request: Request, env: Env): Promise<Response> {
  const started = Date.now()

  let series: unknown
  let cachedOnly = false
  try {
    const body = (await request.json()) as { series?: unknown; cachedOnly?: unknown }
    series = body.series
    cachedOnly = body.cachedOnly === true
  } catch {
    log('series.bad_request', { status: 400, reason: 'body was not JSON' })
    return json({ error: 'Send a JSON body with a "series" array.' }, 400)
  }

  if (!isSeriesQueryList(series)) {
    log('series.bad_request', { status: 400, reason: 'entries missing a name' })
    return json({ error: 'Each entry needs a "name", and may have an "author".' }, 400)
  }
  const limit = cachedOnly ? MAX_CACHED_ONLY : MAX_SERIES
  if (series.length === 0 || series.length > limit) {
    log('series.bad_request', { status: 400, reason: 'batch size', size: series.length })
    return json({ error: `Send between 1 and ${limit} series.` }, 400)
  }

  const now = Date.now()
  const today = new Date(now).toISOString().slice(0, 10)

  try {
    const keys = series.map((item) => cacheKey(item.name, item.author))
    const byKey = new Map(keys.map((key, index) => [key, series[index]]))

    let cached = new Map<string, SeriesResult>()
    let misses = keys
    if (env.DB) {
      const lookup = await readCache(env.DB, keys, now)
      cached = lookup.hits
      misses = lookup.misses
    } else {
      // Name the bindings that DO exist. A binding declared under the wrong
      // name looks identical to no binding at all from inside the Worker.
      log('cache.unavailable', { expected: 'DB', bindings: Object.keys(env).sort() })
    }

    // Two series names can normalise to one key. Look each key up once.
    const wanted = cachedOnly ? [] : [...new Set(misses)]

    // The daily budget: only as many new series as today's remaining
    // Hardcover requests allow. The rest are told so, not silently dropped.
    // If the count cannot be read, look up anyway and say so in the log — a
    // broken counter must not take the lookup down with it.
    const cap = budgetFrom(env.HARDCOVER_DAILY_BUDGET)
    let spent: number | null = null
    let uniqueMisses = wanted
    if (env.DB && wanted.length > 0) {
      try {
        spent = await spentToday(env.DB, today)
        uniqueMisses = wanted.slice(0, affordable(cap - spent, wanted.length))
      } catch (error) {
        log('budget.unavailable', { message: error instanceof Error ? error.message : String(error) })
      }
    }
    const overBudget = new Set(wanted.slice(uniqueMisses.length))
    if (overBudget.size > 0) {
      log('series.budget_exhausted', { cap, spent, refused: overBudget.size, allowed: uniqueMisses.length })
    }

    if (uniqueMisses.length > 0 && !env.HARDCOVER_TOKEN) {
      log('series.misconfigured', {
        status: 500,
        bindings: Object.keys(env).sort(),
        reason: 'HARDCOVER_TOKEN missing or empty',
      })
      return json({ error: 'Series lookup is not configured on this server.' }, 500)
    }

    const meter = { requests: 0 }
    const fetched = uniqueMisses.length
      ? await resolveSeriesNames(
          uniqueMisses.map((key) => byKey.get(key)!),
          env.HARDCOVER_TOKEN,
          meter,
        )
      : []

    if (env.DB && meter.requests > 0) {
      try {
        await recordSpend(env.DB, today, meter.requests)
      } catch (error) {
        log('budget.unavailable', { message: error instanceof Error ? error.message : String(error) })
      }
    }

    let written: { attempted: number; error: string | null } = { attempted: 0, error: null }
    if (env.DB && fetched.length > 0) {
      written = await writeCache(
        env.DB,
        fetched.map((result, index) => ({ key: uniqueMisses[index], result })),
        now,
        today,
      )
    }

    const byQuery = new Map(fetched.map((result) => [result.query, result]))
    const results = cachedOnly
      ? series.flatMap((_, index) => {
          const hit = cached.get(keys[index])
          return hit ? [hit] : []
        })
      : series.map((item, index) => {
          const hit = cached.get(keys[index])
          if (hit) return hit
          if (overBudget.has(keys[index])) return fallback(item.name, BUDGET_DETAIL)
          return byQuery.get(item.name) ?? fallback(item.name)
        })

    const tally = { ok: 0, not_found: 0, error: 0 }
    for (const result of results) tally[result.status] += 1

    log('series.resolved', {
      status: 200,
      cachedOnly,
      requested: series.length,
      // Without this, a missing D1 binding is indistinguishable from a cold
      // cache: both report zero hits and a 200.
      hasDb: Boolean(env.DB),
      cacheHits: cached.size,
      upstreamFetches: uniqueMisses.length,
      // Real requests sent to Hardcover by this call, and the day so far.
      upstreamRequests: meter.requests,
      budgetSpent: spent === null ? null : spent + meter.requests,
      budgetCap: cap,
      overBudget: overBudget.size,
      cacheWrites: written.attempted,
      cacheWriteError: written.error,
      // The exact strings used as keys, so a read/write mismatch is visible
      // rather than inferred.
      sampleKey: keys[0] ?? null,
      ...tally,
      ms: Date.now() - started,
      firstError: results.find((result) => result.detail)?.detail ?? null,
    })
    return json({ results })
  } catch (error) {
    log('series.unhandled', {
      status: 500,
      ms: Date.now() - started,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack?.slice(0, 600) : undefined,
    })
    return json({ error: 'Series lookup failed unexpectedly.' }, 500)
  }
}

function fallback(query: string, detail = 'no result'): SeriesResult {
  return {
    query,
    matchedName: null,
    hardcoverId: null,
    totalBooks: null,
    volumes: [],
    status: 'error',
    detail,
  }
}

function isSeriesQueryList(value: unknown): value is SeriesQuery[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as SeriesQuery).name === 'string',
    )
  )
}
