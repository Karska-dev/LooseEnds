import { aiFailureKind, stopsTheRun } from './aiState.ts'
import type { AiStop } from './aiState.ts'
import type { AiAllowance, AiSeriesResult } from './shared/aiLookup.ts'

/**
 * The experimental AI lookup, from the page's side. Its own endpoint and its
 * own results: nothing here reads or writes what src/resolve.ts keeps for
 * Hardcover.
 *
 * Two steps, as on the server. Opening the tab asks only for what has been
 * looked up before — one request, no cost. Pressing the button then asks for
 * the rest one series at a time, because each is a web search and a model
 * reading pages, and each answer is worth showing as it arrives.
 */

export type { AiAllowance, AiSeriesResult, AiStop }

export interface AiQuery {
  key: string
  name: string
  author?: string
}

/**
 * How the request is sent. The page passes postWithPass; tests pass a stub.
 *
 * Pattern: dependency injection, as in src/shared/aiLookup.ts. The loop
 * below is given its way of talking to the server, so the tests can play
 * the server — out of allowance, throttled, down — without one existing.
 */
export type Post = (payload: unknown) => Promise<Response>

/** A cache-only request takes the whole library. Matches MAX_AI_CACHED_ONLY in worker/ai.ts. */
const PREFETCH_SIZE = 200

/**
 * The least time between two lookups starting. The server allows twelve
 * requests a minute (AI_LIMITER in wrangler.jsonc); a lookup usually takes
 * longer than this anyway, and when one comes back at once — a quick miss —
 * the next waits rather than run the reader into the limit.
 *
 * Technique: client-side throttling. The server's limit is the real one;
 * pacing here only means an honest reader never meets it.
 */
const MIN_GAP_MS = 5500

/**
 * Two unanswered series in a row is the service being down, not bad luck.
 *
 * Pattern: a circuit breaker, in its simplest form. After a run of failures
 * stop calling, rather than send every remaining series into the same wall.
 * A full one would also try again by itself after a pause; here the reader
 * does that with the button.
 */
const MAX_FAILURES_IN_A_ROW = 2

/**
 * Answers already heard this visit, so choosing the same file again asks for nothing.
 *
 * Technique: an in-memory cache at module level. It lives as long as the
 * page is open and is gone on reload: the cheapest of the three layers,
 * in front of the server's table and the lookup itself.
 */
const cache = new Map<string, AiSeriesResult>()
const cacheKey = (item: { name: string; author?: string }) => `${item.name}|${item.author ?? ''}`

/** For tests: start from nothing. */
export function forgetAiResults(): void {
  cache.clear()
}

interface Reply {
  results?: AiSeriesResult[]
  allowance?: AiAllowance
  error?: string
}

function failure(item: AiQuery, detail: string): AiSeriesResult {
  return {
    query: item.name,
    matchedName: null,
    hardcoverId: null,
    totalBooks: null,
    volumes: [],
    status: 'error',
    detail,
    source: 'ai',
    checkedAt: new Date().toISOString().slice(0, 10),
  }
}

/**
 * What the server already has for these series, and how much of today's
 * allowance is left. A failure here is silent: the tab simply opens with
 * nothing found yet, and the button still works.
 */
export async function readAiCached(
  input: AiQuery[],
  post: Post,
): Promise<{ found: Map<string, AiSeriesResult>; allowance: AiAllowance | null }> {
  const found = new Map<string, AiSeriesResult>()
  const asking: AiQuery[] = []
  for (const item of input) {
    const known = cache.get(cacheKey(item))
    if (known) found.set(item.key, known)
    else asking.push(item)
  }

  let allowance: AiAllowance | null = null
  try {
    // Asked even when everything is known already: it also brings the allowance.
    const batch = asking.length > 0 ? asking.slice(0, PREFETCH_SIZE) : input.slice(0, 1)
    if (batch.length === 0) return { found, allowance }
    const response = await post({
      series: batch.map((item) => ({ name: item.name, author: item.author })),
      cachedOnly: true,
    })
    if (!response.ok) return { found, allowance }
    const body = (await response.json()) as Reply
    allowance = body.allowance ?? null
    const byName = new Map(batch.map((item) => [item.name, item]))
    for (const result of body.results ?? []) {
      const item = byName.get(result.query)
      if (!item || result.status === 'error') continue
      found.set(item.key, result)
      cache.set(cacheKey(item), result)
    }
  } catch {
    // Offline, throttled, or the check did not pass. The button will say so.
  }
  return { found, allowance }
}

/**
 * Looks the given series up one at a time, in the order given, and reports
 * each answer as it comes. Stops early when carrying on could only fail the
 * same way — the allowance is spent, the server is not set up, the check
 * did not pass — and says why.
 */
export async function lookUpWithAi(
  pending: AiQuery[],
  post: Post,
  events: {
    /** The series now being looked up. */
    onStart?: (item: AiQuery) => void
    onResult: (item: AiQuery, result: AiSeriesResult, allowance: AiAllowance | null) => void
  },
  /** Tests pass 0 so they do not wait. */
  gapMs = MIN_GAP_MS,
): Promise<{ stopped: AiStop | null }> {
  let failuresInARow = 0
  let lastStart = 0

  for (const item of pending) {
    events.onStart?.(item)
    const wait = lastStart + gapMs - Date.now()
    if (lastStart > 0 && wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    lastStart = Date.now()

    let result: AiSeriesResult
    let allowance: AiAllowance | null = null
    try {
      const response = await post({ series: [{ name: item.name, author: item.author }] })
      const text = await response.text()
      let body: Reply = {}
      try {
        body = JSON.parse(text) as Reply
      } catch {
        if (response.ok) throw new Error('the answer was not JSON')
      }
      if (!response.ok) {
        // Keep the server's own words: the panel reads them (aiFailureKind).
        throw new Error(body.error ?? `HTTP ${response.status}`)
      }
      allowance = body.allowance ?? null
      result = body.results?.[0] ?? failure(item, 'the answer was empty')
    } catch (error) {
      result = failure(item, error instanceof Error ? error.message : 'request failed')
    }

    // The result is filed under the name asked for, whatever came back.
    result = { ...result, query: item.name }
    if (result.status !== 'error') cache.set(cacheKey(item), result)
    events.onResult(item, result, allowance)

    if (result.status !== 'error') {
      failuresInARow = 0
      continue
    }
    const kind = aiFailureKind(result.detail)
    if (stopsTheRun(kind)) return { stopped: kind }
    failuresInARow += 1
    if (failuresInARow >= MAX_FAILURES_IN_A_ROW) return { stopped: kind }
  }

  return { stopped: null }
}
