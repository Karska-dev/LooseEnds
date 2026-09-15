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
  for (let index = 0; index < pending.length; index += CHUNK_SIZE) {
    const names = pending.slice(index, index + CHUNK_SIZE)
    let results: SeriesResult[]

    try {
      const response = await fetch('/api/series', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ series: names }),
      })
      if (!response.ok) throw new Error(String(response.status))
      results = ((await response.json()) as { results: SeriesResult[] }).results
    } catch {
      results = names.map((item) => ({
        query: item.name,
        matchedName: null,
        hardcoverId: null,
        totalBooks: null,
        volumes: [],
        status: 'error' as const,
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
