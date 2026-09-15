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
  if (!env.HARDCOVER_TOKEN) {
    return json({ error: 'Series lookup is not configured on this server.' }, 500)
  }

  let series: unknown
  try {
    series = ((await request.json()) as { series?: unknown }).series
  } catch {
    return json({ error: 'Send a JSON body with a "series" array.' }, 400)
  }

  if (!isSeriesQueryList(series)) {
    return json({ error: 'Each entry needs a "name", and may have an "author".' }, 400)
  }
  if (series.length === 0 || series.length > MAX_SERIES) {
    return json({ error: `Send between 1 and ${MAX_SERIES} series.` }, 400)
  }

  const results = await resolveSeriesNames(series, env.HARDCOVER_TOKEN)
  return json({ results })
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': status === 200 ? 'public, max-age=3600' : 'no-store',
    },
  })
}
