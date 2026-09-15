import { resolveSeriesNames } from '../src/shared/hardcover'
import type { SeriesQuery } from '../src/shared/hardcover'

interface Env {
  HARDCOVER_TOKEN: string
  /** Static asset binding: the built Vite output. */
  ASSETS: { fetch(request: Request): Promise<Response> }
}

/** Keep each request well inside the Worker's subrequest budget. */
const MAX_SERIES = 10

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // TEMPORARY diagnostic. Reports which bindings exist and whether the
    // token is non-empty. Never returns the value. Delete once deployment
    // is sorted — see TODO.md.
    if (url.pathname === '/api/health') {
      const token = env.HARDCOVER_TOKEN
      return json({
        bindings: Object.keys(env).sort(),
        hasHardcoverToken: typeof token === 'string' && token.length > 0,
        tokenLength: typeof token === 'string' ? token.length : null,
        tokenPrefix: typeof token === 'string' ? token.slice(0, 7) : null,
      })
    }

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

  try {
    const results = await resolveSeriesNames(series, env.HARDCOVER_TOKEN)
    const tally = { ok: 0, not_found: 0, error: 0 }
    for (const result of results) tally[result.status] += 1

    log('series.resolved', {
      status: 200,
      requested: series.length,
      ...tally,
      ms: Date.now() - started,
      // The first upstream failure, so a bad token or a rate limit is visible
      // in the logs rather than only in the browser.
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
