import type { SeriesResult } from './shared/hardcover'

export type { SeriesResult }

/** The Function caps each request; keep the client in step with it. */
const CHUNK_SIZE = 10

const cache = new Map<string, SeriesResult>()

export async function resolveAllSeries(
  input: { key: string; name: string; author?: string }[],
  /** Called after every chunk so results can be rendered as they arrive. */
  onChunk?: (done: number, total: number, soFar: Map<string, SeriesResult>) => void,
): Promise<Map<string, SeriesResult>> {
  const output = new Map<string, SeriesResult>()
  const byName = new Map<string, string>()

  const pending: { name: string; author?: string }[] = []
  for (const item of input) {
    byName.set(item.name, item.key)
    const cached = cache.get(item.name)
    if (cached && cached.status !== 'error') {
      output.set(item.key, cached)
    } else {
      pending.push({ name: item.name, author: item.author })
    }
  }

  let done = 0
  let stopped = false

  for (let index = 0; index < pending.length; index += CHUNK_SIZE) {
    if (stopped) break
    const names = pending.slice(index, index + CHUNK_SIZE)
    let results: SeriesResult[]

    try {
      const response = await fetch('/api/series', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ series: names }),
      })
      const body = await response.text()
      if (response.status === 429) {
        // Sending the remaining chunks would only deepen the throttle.
        stopped = true
      }
      if (!response.ok) {
        // Keep the server's own words: "not configured", "Use POST", a 405
        // from a misrouted deploy. Throwing away the body cost a debugging
        // round trip once already.
        let detail = `HTTP ${response.status}`
        try {
          const parsed = JSON.parse(body) as { error?: string }
          if (parsed.error) detail = parsed.error
        } catch {
          detail = `HTTP ${response.status} (not JSON)`
        }
        throw new Error(detail)
      }
      results = (JSON.parse(body) as { results: SeriesResult[] }).results
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'request failed'
      results = names.map((item) => ({
        query: item.name,
        matchedName: null,
        hardcoverId: null,
        totalBooks: null,
        volumes: [],
        status: 'error' as const,
        detail,
      }))
    }

    for (const result of results) {
      const key = byName.get(result.query)
      if (!key) continue
      output.set(key, result)
      if (result.status !== 'error') cache.set(result.query, result)
    }

    done += names.length
    onChunk?.(Math.min(done, pending.length), pending.length, new Map(output))
  }

  return output
}
