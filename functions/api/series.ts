import { resolveSeriesNames } from '../../src/shared/hardcover'
import type { SeriesQuery } from '../../src/shared/hardcover'

interface Env {
  HARDCOVER_TOKEN: string
}

/**
 * Minimal shape of what Cloudflare Pages passes in. Declared here rather than
 * pulling in @cloudflare/workers-types for one annotation.
 */
interface PagesContext {
  request: Request
  env: Env
}

/** Keep each request well inside the Worker's subrequest budget. */
const MAX_NAMES = 10

export const onRequestPost = async (context: PagesContext): Promise<Response> => {
  const token = context.env.HARDCOVER_TOKEN
  if (!token) {
    return json({ error: 'Series lookup is not configured on this server.' }, 500)
  }

  let series: unknown
  try {
    series = ((await context.request.json()) as { series?: unknown }).series
  } catch {
    return json({ error: 'Send a JSON body with a "series" array.' }, 400)
  }

  const valid =
    Array.isArray(series) &&
    series.every(
      (item) => typeof item === 'object' && item !== null && typeof (item as SeriesQuery).name === 'string',
    )
  if (!valid) {
    return json({ error: 'Each entry needs a "name", and may have an "author".' }, 400)
  }
  if (series.length === 0 || series.length > MAX_NAMES) {
    return json({ error: `Send between 1 and ${MAX_NAMES} series.` }, 400)
  }

  const results = await resolveSeriesNames(series as SeriesQuery[], token)
  return json({ results })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=3600',
    },
  })
}
