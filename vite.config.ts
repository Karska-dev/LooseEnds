import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import type { Plugin } from 'vite'
import {
  aiLookupSeries,
  normalise,
  pagesFromTavily,
  searchQueryFor,
  tavilyRequestBody,
} from './src/shared/aiLookup.ts'
import type { AiSeriesResult, ModelFn, SearchFn } from './src/shared/aiLookup.ts'
import { LookupError, newAiMeter, ollamaModel, tavilySearch } from './src/shared/aiProviders.ts'
import { resolveSeriesNames } from './src/shared/hardcover.ts'
import type { SeriesQuery } from './src/shared/hardcover.ts'
import { aiFailure, failureDetail, withRetryDay } from './worker/ai.ts'
import { cacheKey } from './worker/cache.ts'

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
      // Turnstile in dev: Cloudflare's always-pass invisible test key, and any
      // token buys a pass. The real check lives in worker/index.ts; this only
      // keeps the page's flow identical, so dev exercises the same code path.
      // /api/series here does not ask for the pass.
      server.middlewares.use('/api/pass', async (request, response) => {
        response.setHeader('content-type', 'application/json')
        response.setHeader('cache-control', 'no-store')
        if (request.method === 'GET') {
          response.end(JSON.stringify({ siteKey: '1x00000000000000000000BB' }))
          return
        }
        for await (const _ of request) {
          // Drain the body; its token is not checked in dev.
        }
        response.end(JSON.stringify({ pass: 'dev', expires: Date.now() + 15 * 60 * 1000 }))
      })

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

/** Where dev keeps what it has already paid for. Git-ignored. */
const DEV_CACHE = '.dev-cache'

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

function saveJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 1))
}

/**
 * Tavily, with every answer saved to .dev-cache/tavily and replayed. The
 * free plan is 1,000 searches a month and dev would spend them on reloads.
 * The files are the ones scripts/ai-explain.mjs writes and reads, under the
 * same names, so a series the benchmark has searched costs nothing here.
 *
 * Technique: record and replay. The first call goes to the real service and
 * its answer is written to disk; every later call reads the file.
 */
function savedSearch(query: SeriesQuery, key: string, meter: ReturnType<typeof newAiMeter>): SearchFn {
  const slug = normalise(`${query.name} ${query.author ?? ''}`).replace(/ /g, '-').slice(0, 120)
  return async (text) => {
    const second = text === searchQueryFor(query) ? '' : '.again'
    const path = join(DEV_CACHE, 'tavily', `${slug}${second}.json`)
    const asked = JSON.stringify(tavilyRequestBody(text))

    // Replayed only if it answers the same question asked the same way.
    const saved = readJson<{ _request?: unknown }>(path)
    if (saved && JSON.stringify(saved._request) === asked) return pagesFromTavily(saved)

    if (!key) throw new LookupError('key', 'TAVILY_KEY is not set in .env.local')
    // Pattern: a decorator. `keeping` has fetch's shape and does fetch's
    // job, and saves a copy on the way through; tavilySearch cannot tell.
    // clone() is needed because a response body can be read only once.
    const keeping: typeof fetch = async (input, init) => {
      const response = await fetch(input, init)
      if (response.ok) saveJson(path, { ...((await response.clone().json()) as object), _request: JSON.parse(asked) })
      return response
    }
    return tavilySearch(key, meter, keeping)(text)
  }
}

/**
 * The local model, with every reply saved to .dev-cache/model and replayed:
 * the same model asked the same thing answers the same, and a local model
 * takes most of a minute to say it. Again the files are the ones
 * scripts/ai-explain.mjs keeps, so what the benchmark has read is instant.
 *
 * Technique: a content-addressed cache. The file name is a hash of the
 * model and the whole prompt, so nothing has to decide when an entry is out
 * of date: change the prompt at all and it is simply a different file.
 */
function savedModel(run: ModelFn, model: string, replayed: { count: number }): ModelFn {
  return async (request) => {
    const key = createHash('sha1').update(`${model}\n${request.system}\n${request.user}`).digest('hex').slice(0, 16)
    const path = join(DEV_CACHE, 'model', `${model.replace(/[^a-z0-9.]+/gi, '-')}-${key}.json`)
    const saved = readJson<{ reply?: string }>(path)
    if (saved?.reply) {
      replayed.count += 1
      return saved.reply
    }
    const reply = await run(request)
    saveJson(path, { reply })
    return reply
  }
}

/**
 * In production /api/ai-series is worker/ai.ts: Tavily, Workers AI, a D1
 * cache and a daily allowance. Dev runs the same lookup (src/shared/
 * aiLookup.ts) with a local model through Ollama in place of Workers AI,
 * files in .dev-cache in place of D1, and no allowance and no lookup pass.
 * As with /api/series above, what the Worker learns has to be taught here.
 *
 * To look a series up again, delete its file in .dev-cache/ai-series (and,
 * to make the model read the pages afresh, its reply in .dev-cache/model).
 */
function aiSeriesApi(env: Record<string, string>): Plugin {
  const tavilyKey = env.TAVILY_KEY ?? ''
  const model = env.OLLAMA_MODEL || 'qwen3.5:9b'
  const ollamaUrl = env.OLLAMA_URL || 'http://localhost:11434'
  const saved = (query: SeriesQuery) =>
    join(DEV_CACHE, 'ai-series', `${cacheKey(query.name, query.author).replace(/[^a-z0-9]+/g, '-')}.json`)

  return {
    name: 'loose-ends-ai-series-api',
    configureServer(server) {
      server.middlewares.use('/api/ai-series', async (request, response) => {
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
          const fromDisk = (query: SeriesQuery): AiSeriesResult | null => {
            const hit = readJson<AiSeriesResult>(saved(query))
            return hit ? { ...hit, query: query.name } : null
          }

          if (cachedOnly) {
            const results = Array.isArray(series) ? series.flatMap((query) => fromDisk(query) ?? []) : []
            response.end(JSON.stringify({ results }))
            return
          }

          if (!Array.isArray(series) || series.length !== 1) {
            response.statusCode = 400
            response.end(JSON.stringify({ error: 'Send one series at a time.' }))
            return
          }

          const query = series[0]
          const hit = fromDisk(query)
          if (hit) {
            response.end(JSON.stringify({ results: [hit] }))
            return
          }

          const started = Date.now()
          const today = new Date().toISOString().slice(0, 10)
          const meter = newAiMeter()
          const replayed = { count: 0 }
          let result: AiSeriesResult
          try {
            const outcome = await aiLookupSeries(query, {
              today,
              search: savedSearch(query, tavilyKey, meter),
              runModel: savedModel(ollamaModel(ollamaUrl, model, meter), model, replayed),
            })
            result = withRetryDay(outcome.result, Date.now(), today)
            // A failure is not a fact about the series; everything else is kept.
            saveJson(saved(query), result)
            console.log(
              `[ai-series] ${query.name}: ${result.status}` +
                (result.status === 'ok' ? `, ${outcome.report.kept} books` : ` (${result.detail ?? ''})`) +
                `, ${Math.round((Date.now() - started) / 1000)}s, ${model},` +
                ` ${meter.credits} Tavily credit${meter.credits === 1 ? '' : 's'}` +
                (meter.searches === 0 ? ' (search replayed from .dev-cache)' : '') +
                (replayed.count > 0 ? ' (model reply replayed)' : ''),
            )
          } catch (error) {
            console.log(`[ai-series] ${query.name} failed:`, error instanceof Error ? error.message : error)
            result = aiFailure(query, failureDetail(error), today)
          }
          response.end(JSON.stringify({ results: [result] }))
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
  return { plugins: [react(), seriesApi(env.HARDCOVER_TOKEN), aiSeriesApi(env)] }
})
