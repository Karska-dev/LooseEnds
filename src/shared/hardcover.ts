export interface Volume {
  position: number
  title: string
  releaseDate: string | null
}

export interface SeriesResult {
  /** The name we searched for, so the client can match results back. */
  query: string
  matchedName: string | null
  hardcoverId: number | null
  /** Hardcover's own count of the main-line books, ignoring translations. */
  totalBooks: number | null
  volumes: Volume[]
  status: 'ok' | 'not_found' | 'error'
  /** Why it failed. Never let a failure masquerade as an empty result. */
  detail?: string
}

const ENDPOINT = 'https://api.hardcover.app/v1/graphql'
/** Hardcover allows at most 5 top-level queries per request. */
const ALIAS_LIMIT = 5
/** Hardcover allows 60 requests per minute. Stay just under one per second. */
const MIN_REQUEST_GAP_MS = 1100

interface SearchHit {
  id: string
  name: string
  author_name?: string
  primary_books_count?: number
  readers_count?: number
}

export interface SeriesQuery {
  name: string
  author?: string
}

function normaliseName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/** "Rina Kent" and "Kent, Rina" are the same person to a reader. */
function sameAuthor(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const left = normaliseName(a).split(' ').filter(Boolean)
  const right = normaliseName(b).split(' ').filter(Boolean)
  if (left.length === 0 || right.length === 0) return false
  const surnameMatch = left[left.length - 1] === right[right.length - 1]
  const overlap = left.filter((part) => right.includes(part)).length
  return surnameMatch || overlap >= 2
}

type Outcome<T> = { ok: true; data: T } | { ok: false; detail: string }

/**
 * Returns an explicit failure rather than null. A throttled request and a
 * series that genuinely does not exist must never look the same.
 */
async function gql<T>(token: string, query: string): Promise<Outcome<T>> {
  let lastDetail = 'unreachable'

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query }),
      })

      if (response.status === 429 || response.status >= 500) {
        lastDetail = `HTTP ${response.status}`
        await delay(2000 * 2 ** attempt)
        continue
      }
      if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` }

      const body = (await response.json()) as { data?: T; errors?: { message?: string }[] }
      if (body.errors?.length) {
        return { ok: false, detail: body.errors[0]?.message ?? 'GraphQL error' }
      }
      if (!body.data) return { ok: false, detail: 'empty response' }
      return { ok: true, data: body.data }
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : 'network error'
      await delay(2000 * 2 ** attempt)
    }
  }

  return { ok: false, detail: lastDetail }
}

/**
 * Hardcover carries duplicate series entries created by users — a real one
 * with readers and books, and empty shells with the same name. Rank by book
 * count then readers so the shells never win.
 */
function bestHit(hits: SearchHit[], author?: string): SearchHit | null {
  const withBooks = hits.filter((hit) => (hit.primary_books_count ?? 0) > 0)
  let pool = withBooks.length > 0 ? withBooks : hits

  // A one-word series name like "Villain" matches dozens of series. The author
  // is the only thing that makes such a lookup unambiguous.
  const byAuthor = pool.filter((hit) => sameAuthor(hit.author_name, author))
  if (byAuthor.length > 0) pool = byAuthor

  return (
    [...pool].sort(
      (a, b) =>
        (b.primary_books_count ?? 0) - (a.primary_books_count ?? 0) ||
        (b.readers_count ?? 0) - (a.readers_count ?? 0),
    )[0] ?? null
  )
}

function escapeForGql(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

async function searchSeries(
  token: string,
  name: string,
  author?: string,
): Promise<Outcome<SearchHit | null>> {
  const query = `query { search(query: "${escapeForGql(name)}", query_type: "series", per_page: 15, page: 1) { results } }`
  const outcome = await gql<{ search?: { results?: { hits?: { document: SearchHit }[] } } }>(
    token,
    query,
  )
  if (!outcome.ok) return outcome
  const hits = (outcome.data.search?.results?.hits ?? []).map((hit) => hit.document)
  return { ok: true, data: bestHit(hits, author) }
}

interface SeriesNode {
  name: string
  primary_books_count: number | null
  book_series: {
    position: number | null
    book: { title: string; release_date: string | null; users_read_count: number | null } | null
  }[]
}

/**
 * Every translation and box set shares a position with the original, so one
 * position yields many rows. The edition with the most readers is the one
 * people mean — far more reliable than Hardcover's `compilation` flag, which
 * hides real books and keeps box sets.
 */
function pickOnePerPosition(node: SeriesNode): Volume[] {
  const best = new Map<number, { title: string; releaseDate: string | null; readers: number }>()

  for (const entry of node.book_series) {
    const position = entry.position
    const book = entry.book
    if (position === null || !book) continue
    const readers = book.users_read_count ?? 0
    const current = best.get(position)
    if (!current || readers > current.readers) {
      best.set(position, { title: book.title, releaseDate: book.release_date, readers })
    }
  }

  return [...best.entries()]
    .map(([position, value]) => ({
      position,
      title: value.title,
      releaseDate: value.releaseDate,
    }))
    .sort((a, b) => a.position - b.position)
}

const SERIES_FIELDS = `name primary_books_count book_series(order_by: {position: asc}) { position book { title release_date users_read_count } }`

async function fetchSeriesBatch(
  token: string,
  ids: number[],
): Promise<Outcome<Map<number, SeriesNode>>> {
  const aliases = ids.map((id, index) => `s${index}: series_by_pk(id: ${id}) { ${SERIES_FIELDS} }`)
  const outcome = await gql<Record<string, SeriesNode | null>>(
    token,
    `query { ${aliases.join(' ')} }`,
  )
  if (!outcome.ok) return outcome

  const out = new Map<number, SeriesNode>()
  ids.forEach((id, index) => {
    const node = outcome.data[`s${index}`]
    if (node) out.set(id, node)
  })
  return { ok: true, data: out }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function resolveSeriesNames(
  queries: SeriesQuery[],
  token: string,
): Promise<SeriesResult[]> {
  const names = queries.map((item) => item.name)
  const results = new Map<string, SeriesResult>()
  const found: { query: string; id: number; name: string; total: number | null }[] = []

  // Phase 1 — one search per name. Hardcover allows only one search per request.
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]
    if (index > 0) await delay(MIN_REQUEST_GAP_MS)

    const outcome = await searchSeries(token, name, queries[index].author)
    if (!outcome.ok) {
      results.set(name, blank(name, 'error', outcome.detail))
      continue
    }
    const hit = outcome.data
    if (!hit) {
      results.set(name, blank(name, 'not_found'))
      continue
    }
    found.push({
      query: name,
      id: Number(hit.id),
      name: hit.name,
      total: hit.primary_books_count ?? null,
    })
  }

  // Phase 2 — five series per request via aliases.
  for (let index = 0; index < found.length; index += ALIAS_LIMIT) {
    const batch = found.slice(index, index + ALIAS_LIMIT)
    await delay(MIN_REQUEST_GAP_MS)
    const outcome = await fetchSeriesBatch(
      token,
      batch.map((item) => item.id),
    )

    for (const item of batch) {
      if (!outcome.ok) {
        results.set(item.query, {
          ...blank(item.query, 'error', outcome.detail),
          matchedName: item.name,
          hardcoverId: item.id,
          totalBooks: item.total,
        })
        continue
      }
      const node = outcome.data.get(item.id)
      const volumes = node ? pickOnePerPosition(node) : []
      results.set(item.query, {
        query: item.query,
        matchedName: node?.name ?? item.name,
        hardcoverId: item.id,
        totalBooks: node?.primary_books_count ?? item.total,
        volumes,
        status: volumes.length > 0 ? 'ok' : 'not_found',
      })
    }
  }

  return names.map((name) => results.get(name) ?? blank(name, 'error', 'no result'))
}

function blank(
  query: string,
  status: SeriesResult['status'],
  detail?: string,
): SeriesResult {
  return {
    query,
    matchedName: null,
    hardcoverId: null,
    totalBooks: null,
    volumes: [],
    status,
    ...(detail ? { detail } : {}),
  }
}
