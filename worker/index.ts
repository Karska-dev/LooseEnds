import { resolveSeriesNames } from '../src/shared/hardcover'
import type { SeriesQuery, SeriesResult } from '../src/shared/hardcover'
import { cacheKey, readCache, writeCache } from './cache'
import type { D1Database } from './cache'

interface Env {
  HARDCOVER_TOKEN: string
  /** Static asset binding: the built Vite output. */
  ASSETS: { fetch(request: Request): Promise<Response> }
  /** Absent in local development, where the cache is simply skipped. */
  DB?: D1Database
}

/** Keep each request well inside the Worker's subrequest budget. */
const MAX_SERIES = 10

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api/series') {
      if (request.method !== 'POST') {
        return json({ error: 'Use POST with a JSON body.' }, 405)
      }
      return handleSeries(request, env)
    }

    // Everything else is the built single-page app.
    return env.ASSETS.fetch(request)
  },
}

async function handleSeries(request: Request, env: Env): Promise<Response> {
  const started = Date.now()

  if (!env.HARDCOVER_TOKEN) {
    log('series.misconfigured', {
      status: 500,
      bindings: Object.keys(env).sort(),
      reason: 'HARDCOVER_TOKEN missing or empty',
    })
    return json({ error: 'Series lookup is not configured on this server.' }, 500)
  }

  let series: unknown
  try {
    series = ((await request.json()) as { series?: unknown }).series
  } catch {
    log('series.bad_request', { status: 400, reason: 'body was not JSON' })
    return json({ error: 'Send a JSON body with a "series" array.' }, 400)
  }

  if (!isSeriesQueryList(series)) {
    log('series.bad_request', { status: 400, reason: 'entries missing a name' })
    return json({ error: 'Each entry needs a "name", and may have an "author".' }, 400)
  }
  if (series.length === 0 || series.length > MAX_SERIES) {
    log('series.bad_request', { status: 400, reason: 'batch size', size: series.length })
    return json({ error: `Send between 1 and ${MAX_SERIES} series.` }, 400)
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
    const uniqueMisses = [...new Set(misses)]

    const fetched = uniqueMisses.length
      ? await resolveSeriesNames(
          uniqueMisses.map((key) => byKey.get(key)!),
          env.HARDCOVER_TOKEN,
        )
      : []

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
    const results = series.map((item, index) => {
      const hit = cached.get(keys[index])
      return hit ?? byQuery.get(item.name) ?? fallback(item.name)
    })

    const tally = { ok: 0, not_found: 0, error: 0 }
    for (const result of results) tally[result.status] += 1

    log('series.resolved', {
      status: 200,
      requested: series.length,
      // Without this, a missing D1 binding is indistinguishable from a cold
      // cache: both report zero hits and a 200.
      hasDb: Boolean(env.DB),
      cacheHits: cached.size,
      upstreamFetches: uniqueMisses.length,
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

function fallback(query: string): SeriesResult {
  return {
    query,
    matchedName: null,
    hardcoverId: null,
    totalBooks: null,
    volumes: [],
    status: 'error',
    detail: 'no result',
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

/**
 * One line of JSON per interesting event. A handled 500 produces no stack
 * trace and no console output on its own, so anything we do not log here is
 * invisible in production — which is how a missing binding looked like
 * silence rather than a problem.
 */
function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }))
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': status === 200 ? 'public, max-age=3600' : 'no-store',
    },
  })
}
