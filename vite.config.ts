import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import type { Plugin } from 'vite'
import { resolveSeriesNames } from './src/shared/hardcover.ts'
import type { SeriesQuery } from './src/shared/hardcover.ts'

/** Matches MAX_SERIES in worker/index.ts, so dev refuses what production refuses. */
const MAX_SERIES = 10

/**
 * In production /api/series is a Cloudflare Worker. Dev runs the same
 * resolver module, but the HTTP handling around it is necessarily separate —
 * there is no D1 and no rate limiter here. Anything the Worker learns to
 * understand has to be taught to this handler too, or dev silently behaves
 * differently from production.
 */
function seriesApi(token: string): Plugin {
  return {
    name: 'loose-ends-series-api',
    configureServer(server) {
      server.middlewares.use('/api/series', async (request, response) => {
        if (request.method !== 'POST') {
          response.statusCode = 405
          response.end()
          return
        }

        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(chunk as Buffer)

        response.setHeader('content-type', 'application/json')

        try {
          const { series, cachedOnly } = JSON.parse(Buffer.concat(chunks).toString()) as {
            series: SeriesQuery[]
            cachedOnly?: boolean
          }

          // There is no D1 in dev, so every key is a miss. Answering at once
          // matters: the prefetch sends the whole library in one request, and
          // resolving it upstream would take minutes and look like a hang.
          if (cachedOnly) {
            response.end(JSON.stringify({ results: [] }))
            return
          }

          if (!token) {
            response.statusCode = 500
            response.end(
              JSON.stringify({ error: 'HARDCOVER_TOKEN is not set in .env.local' }),
            )
            return
          }

          if (!Array.isArray(series) || series.length === 0 || series.length > MAX_SERIES) {
            response.statusCode = 400
            response.end(
              JSON.stringify({ error: `Send between 1 and ${MAX_SERIES} series.` }),
            )
            return
          }

          const started = Date.now()
          const results = await resolveSeriesNames(series, token)
          console.log(
            `[series] ${results.length} in ${Math.round((Date.now() - started) / 1000)}s` +
              ' (no cache in dev: every lookup is a live Hardcover call)',
          )
          const failed = results.filter((result) => result.status === 'error')
          if (failed.length > 0) {
            console.log(`[series] ${failed.length}/${results.length} failed:`, failed[0].detail)
          }
          response.end(JSON.stringify({ results }))
        } catch (error) {
          response.statusCode = 500
          response.end(JSON.stringify({ error: String(error) }))
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return { plugins: [react(), seriesApi(env.HARDCOVER_TOKEN)] }
})
