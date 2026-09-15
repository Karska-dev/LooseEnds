import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import type { Plugin } from 'vite'
import { resolveSeriesNames } from './src/shared/hardcover.ts'
import type { SeriesQuery } from './src/shared/hardcover.ts'

/**
 * In production /api/series is a Cloudflare Pages Function. In dev we run the
 * same module in the Vite server so there is one implementation, not two.
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
        if (!token) {
          response.statusCode = 500
          response.end(JSON.stringify({ error: 'HARDCOVER_TOKEN is not set in .env.local' }))
          return
        }

        try {
          const { series } = JSON.parse(Buffer.concat(chunks).toString()) as {
            series: SeriesQuery[]
          }
          const results = await resolveSeriesNames(series, token)
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
