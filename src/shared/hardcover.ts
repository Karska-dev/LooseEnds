export interface Edition {
  title: string
  releaseDate: string | null
  languageId: number | null
  readers: number
  coverUrl: string | null
  /** Dominant colour of the cover, for the slot to hold while it loads. */
  coverColor: string | null
  /** Links back to hardcover.app, which is also the attribution. */
  slug: string | null
  /**
   * Release date of the default audiobook edition in the same language, when
   * Hardcover has one. Extra information only: status follows `releaseDate`,
   * what there is to read. Missing on entries cached before it existed.
   */
  audioDate?: string | null
  /**
   * Hardcover has an audiobook edition of this book in the same language,
   * dated or not. Missing on entries cached before it existed.
   */
  hasAudio?: boolean
}

export interface Volume {
  position: number
  /** One entry per language, best-read first. The client picks. */
  editions: Edition[]
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
/**
 * Series fetched together. The Worker never resolves more than ten per
 * request, so in practice one batch is the whole request.
 */
const SERIES_PER_FETCH = 10
/** Books asked for in one request; a long series with every translation runs to hundreds. */
const BOOKS_PER_FETCH = 250
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
/**
 * Both token formats — legacy JWTs ("eyJ...") and personal access tokens
 * ("hc_pat_...") — authenticate as "Bearer <token>". The API docs say to send
 * "your token as the value", but the server is stricter than the prose:
 * without the prefix it answers 400 "Invalid Authorization format".
 *
 * Strips a "Bearer " the reader may have copied along with the key, so the
 * prefix is never doubled.
 */
export function authHeader(token: string): string {
  return `Bearer ${token.trim().replace(/^Bearer\s+/i, '').trim()}`
}

/**
 * Counts the HTTP requests actually sent to Hardcover, retries included.
 * Their daily limit is counted in requests, so the daily budget
 * (worker/budget.ts) must be too.
 */
export interface Meter {
  requests: number
}

async function gql<T>(token: string, query: string, meter?: Meter): Promise<Outcome<T>> {
  let lastDetail = 'unreachable'
  const authorization = authHeader(token)

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (meter) meter.requests += 1
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query }),
      })

      if (response.status === 429 || response.status >= 500) {
        lastDetail = `HTTP ${response.status}`
        await delay(2000 * 2 ** attempt)
        continue
      }

      // Retrying a rejected token just spends the rate limit on the same
      // answer, and "HTTP 401" alone sends you looking in the wrong place.
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          detail:
            `Hardcover rejected the token (HTTP ${response.status}). ` +
            'Check it is current, and copied whole with no "Bearer " prefix.',
        }
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
/**
 * "The Mistborn Saga" is about "Mistborn"; "The Cosmere" is not.
 * Exported for scripts/explain-match.mjs, so the diagnostic reports the real
 * decision rather than a copy of it that can drift.
 */
export function nameRelated(name: string, query: string): boolean {
  const left = normaliseName(name)
  const right = normaliseName(query)
  return left.includes(right) || right.includes(left)
}

/** Words that say "this is a series" without saying which one. */
const GENERIC_WORDS = new Set([
  'the', 'a', 'an', 'series', 'saga', 'trilogy', 'cycle', 'chronicles', 'novels', 'books', 'sequence',
])

function coreName(value: string): string {
  return normaliseName(value)
    .split(' ')
    .filter((word) => !GENERIC_WORDS.has(word))
    .join(' ')
}

/**
 * How close a series name is to the one in the reader's export.
 *   0 — the same name                    "Foundation"         for "Foundation"
 *   1 — the same but for generic words   "The Mistborn Saga"  for "Mistborn"
 *   2 — merely contains it               "Greater Foundation Universe",
 *                                        "Foundation (Chronological Order)"
 */
export function nameCloseness(name: string, query: string): 0 | 1 | 2 {
  if (normaliseName(name) === normaliseName(query)) return 0
  const core = coreName(name)
  return core !== '' && core === coreName(query) ? 1 : 2
}

/**
 * A closer name only wins if it is a real series, not a near-empty duplicate
 * a user created: it needs at least this share of the readers of the most-
 * read candidate. "Foundation" has 11,159 against the universe's 12,715; a
 * shell with three readers beside a series with thousands does not qualify.
 */
const CLOSER_NAME_MIN_SHARE = 0.2

/**
 * Narrow progressively, keeping each filter only when it leaves something.
 *
 * Name similarity has to come first. Searching "Mistborn" returns both "The
 * Mistborn Saga" (10 books, 32k readers) and "The Cosmere" (34 books, 73k
 * readers), which is a superset containing it — so neither book count nor
 * reader count picks the right one. Only the name does.
 *
 * And among related names, the closest wins before popularity is consulted.
 * Searching "Foundation" returns "Foundation" (7 books), "Foundation
 * (Chronological Order)", "Foundation Universe" and "Greater Foundation
 * Universe" (15 books, the most readers) — all by Asimov, all containing the
 * word. A Goodreads "(Foundation, #1)" means the first of those; picking by
 * readers filed it under I, Robot.
 */
export function bestHit(
  hits: SearchHit[],
  query: string,
  author?: string,
): SearchHit | null {
  let pool = hits

  // Empty shells that users created and never filled in.
  const withBooks = pool.filter((hit) => (hit.primary_books_count ?? 0) > 0)
  if (withBooks.length > 0) pool = withBooks

  const byName = pool.filter((hit) => nameRelated(hit.name, query))
  if (byName.length > 0) pool = byName

  // A one-word name like "Villain" matches dozens of series; the author is
  // what makes that lookup unambiguous.
  const byAuthor = pool.filter((hit) => sameAuthor(hit.author_name, author))
  if (byAuthor.length > 0) pool = byAuthor

  const byPopularity = (a: SearchHit, b: SearchHit) =>
    (b.readers_count ?? 0) - (a.readers_count ?? 0) ||
    (b.primary_books_count ?? 0) - (a.primary_books_count ?? 0)

  // Closest name first, as long as it is not a near-empty duplicate.
  const mostReaders = Math.max(0, ...pool.map((hit) => hit.readers_count ?? 0))
  for (const closeness of [0, 1] as const) {
    const close = pool
      .filter((hit) => nameCloseness(hit.name, query) === closeness)
      .filter((hit) => (hit.readers_count ?? 0) >= mostReaders * CLOSER_NAME_MIN_SHARE)
    if (close.length > 0) return [...close].sort(byPopularity)[0]
  }

  return [...pool].sort(byPopularity)[0] ?? null
}

/**
 * The reader's author is known, and the pick is by somebody else: nothing by
 * that author was among the hits. "Legacy" returns fifteen series called
 * exactly "Legacy", none of them Melissa K. Roehrich's "The Legacy Series".
 */
export function byAnotherAuthor(pick: SearchHit | null, author?: string): boolean {
  return Boolean(author) && pick !== null && !sameAuthor(pick.author_name, author)
}

/**
 * The pick from the second search, the one with the author's name in it.
 * Stricter than bestHit: the hit must be by the reader's author AND about
 * the reader's series. Without the name test this search would hand back
 * whatever else that author wrote, which is worse than the first pick.
 */
export function bestHitByAuthor(hits: SearchHit[], query: string, author: string): SearchHit | null {
  const theirs = hits.filter(
    (hit) =>
      (hit.primary_books_count ?? 0) > 0 &&
      nameRelated(hit.name, query) &&
      sameAuthor(hit.author_name, author),
  )
  return theirs.length > 0 ? bestHit(theirs, query, author) : null
}

function escapeForGql(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

async function searchHits(token: string, text: string, meter?: Meter): Promise<Outcome<SearchHit[]>> {
  const query = `query { search(query: "${escapeForGql(text)}", query_type: "series", per_page: 15, page: 1) { results } }`
  const outcome = await gql<{ search?: { results?: { hits?: { document: SearchHit }[] } } }>(
    token,
    query,
    meter,
  )
  if (!outcome.ok) return outcome
  return { ok: true, data: (outcome.data.search?.results?.hits ?? []).map((hit) => hit.document) }
}

/**
 * One search by name. A second, with the author's name added, only when the
 * first found the name but nobody by the reader's author — a one-word name
 * shared by more series than a page of hits holds. If the second finds the
 * author's series it wins; if not, the first pick stands, because a series
 * can honestly be filed under another name (a co-author, a pen name).
 */
async function searchSeries(
  token: string,
  name: string,
  author?: string,
  meter?: Meter,
): Promise<Outcome<SearchHit | null>> {
  const first = await searchHits(token, name, meter)
  if (!first.ok) return first
  const pick = bestHit(first.data, name, author)
  if (!author || !byAnotherAuthor(pick, author)) return { ok: true, data: pick }

  await delay(MIN_REQUEST_GAP_MS)
  const second = await searchHits(token, `${name} ${author}`, meter)
  // A failure here is a failure, not "keep the first pick": the answer is
  // cached for weeks, and a throttled request must not decide it.
  if (!second.ok) return second
  return { ok: true, data: bestHitByAuthor(second.data, name, author) ?? pick }
}

export interface BookNode {
  /** Present on flat fetches; breaks ties so the result never depends on row order. */
  id?: number
  title: string
  slug: string | null
  release_date: string | null
  users_read_count: number | null
  image: { url: string | null; color: string | null } | null
  default_ebook_edition: { language_id: number | null } | null
  default_physical_edition: { language_id: number | null } | null
  default_audio_edition: { language_id: number | null; release_date: string | null } | null
  /** Set on a duplicate record: the id of the book it is a copy of. */
  canonical_id?: number | null
}

export interface SeriesNode {
  name: string
  primary_books_count: number | null
  book_series: { position: number | null; book: BookNode | null }[]
}

/**
 * The audiobook, only when it is in the same language as the book: a German
 * audiobook says nothing about whether there is an English one.
 */
function sameLanguageAudio(book: BookNode, languageId: number | null) {
  const audio = book.default_audio_edition
  if (!audio) return null
  if (audio.language_id !== null && languageId !== null && audio.language_id !== languageId) return null
  return audio
}

/** Ebook first: translations often have no ebook edition, originals do. */
function languageOf(book: BookNode): number | null {
  return book.default_ebook_edition?.language_id ?? book.default_physical_edition?.language_id ?? null
}

/**
 * Every translation and box set shares a position with the original. Rather
 * than choosing here, keep the best-read edition per language and let the
 * client pick — it knows which language the reader actually reads, and this
 * keeps the response identical for every visitor so it stays cacheable.
 */
/**
 * Box sets do not only sit at position 0. "Drixonian Warriors: The Complete
 * Series" is filed at position 1, beside the real book 1, and a popular one
 * would win on readers and be shown as the first book of the series.
 */
const AGGREGATE_TITLE =
  /\b(complete (series|collection)|box(ed)? set|omnibus|anthology|books?\s*\d+\s*[-\u2013]\s*\d+)\b/i

function isAggregate(title: string): boolean {
  return AGGREGATE_TITLE.test(title)
}

/** A real book beats a bundle at the same position, however many have read it. */
interface Ranked {
  edition: Edition
  /** Hardcover's book id: lower is the older record, usually the original. */
  id: number
}

/**
 * Whether `candidate` should replace `current` at the same position and
 * language. More readers wins. A tie — common among translations nobody has
 * logged — goes to the older record, then to the title, so the answer is the
 * same whatever order Hardcover returns the rows in.
 */
function beats(candidate: Ranked, current: Ranked): boolean {
  const candidateBundle = isAggregate(candidate.edition.title)
  const currentBundle = isAggregate(current.edition.title)
  if (candidateBundle !== currentBundle) return currentBundle
  if (candidate.edition.readers !== current.edition.readers) {
    return candidate.edition.readers > current.edition.readers
  }
  if (candidate.id !== current.id) return candidate.id < current.id
  return candidate.edition.title < current.edition.title
}

/** Most-read first; ties by language id (unknown last), then title. */
function byReaders(a: Edition, b: Edition): number {
  return (
    b.readers - a.readers ||
    (a.languageId ?? Infinity) - (b.languageId ?? Infinity) ||
    (a.title < b.title ? -1 : a.title > b.title ? 1 : 0)
  )
}

export function editionsByPosition(node: SeriesNode): Volume[] {
  const byPosition = new Map<number, Map<string, Ranked>>()

  for (const entry of node.book_series) {
    const position = entry.position
    const book = entry.book
    if (position === null || !book) continue

    let perLanguage = byPosition.get(position)
    if (!perLanguage) {
      perLanguage = new Map()
      byPosition.set(position, perLanguage)
    }

    const languageId = languageOf(book)
    const key = String(languageId ?? 'unknown')
    const edition: Edition = {
      title: book.title,
      releaseDate: book.release_date,
      languageId,
      readers: book.users_read_count ?? 0,
      coverUrl: book.image?.url ?? null,
      // Entries cached before this field existed simply have no colour, and
      // fall back to the empty slot until they expire.
      coverColor: safeColor(book.image?.color),
      slug: book.slug,
      audioDate: sameLanguageAudio(book, languageId)?.release_date ?? null,
      hasAudio: sameLanguageAudio(book, languageId) !== null,
    }
    const candidate: Ranked = { edition, id: book.id ?? Infinity }
    const current = perLanguage.get(key)
    if (!current || beats(candidate, current)) {
      perLanguage.set(key, candidate)
    }
  }

  return [...byPosition.entries()]
    .map(([position, perLanguage]) => ({
      position,
      editions: [...perLanguage.values()]
        .map((ranked) => ranked.edition)
        .sort(byReaders)
        .slice(0, 8),
    }))
    .sort((a, b) => a.position - b.position)
}

/**
 * Upstream values reach a style attribute, so only recognisable colours pass.
 * Anything else becomes null rather than being handed to the browser.
 */
function safeColor(value: string | null | undefined): string | null {
  if (!value) return null
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim()) ? value.trim() : null
}

/**
 * Flat on purpose. Hardcover is introducing a maximum query depth of 3, and
 * the natural query — series → book_series → book → default edition — is 4
 * levels deep. So the tree is fetched as rows and put back together here:
 *
 *   1. the series themselves, and their (series, position, book) links
 *   2. the books those links point to, each with its default editions
 *   3. the originals of any duplicate records among them (see withOriginals)
 *
 * Nothing below nests more than three levels, counting the leaf fields
 * (books → default_audio_edition → release_date), which is the strictest way
 * a depth limit could be counted.
 */
const BOOK_FIELDS =
  'id canonical_id title slug release_date users_read_count image { url color } ' +
  'default_ebook_edition { language_id } default_physical_edition { language_id } ' +
  'default_audio_edition { language_id release_date }'

interface SeriesRow {
  id: number
  name: string
  primary_books_count: number | null
}

interface LinkRow {
  series_id: number
  position: number | null
  book_id: number
}

/**
 * Hardcover keeps a translation, or a copy somebody entered twice, as a book
 * record of its own that points at the original through canonical_id. Such a
 * copy has no language and no readers, and it is often the copy, not the
 * original, that carries the series position: "Dune" #7 is linked to "Łowcy
 * Diuny" and an untagged "Hunters Of Dune", while the real "Hunters of Dune"
 * sits in the same series with no position at all. So a copy stands for its
 * original here.
 *
 * Except when the original has a place of its own in this series, somewhere
 * else: "Dune 2" at #1 is a copy of "Dune Messiah", which is #2. A misfiled
 * copy must not move a book.
 */
export function withOriginals(
  links: { position: number | null; book_id: number }[],
  books: Map<number, BookNode>,
): SeriesNode['book_series'] {
  const placed = new Map<number, Set<number>>()
  for (const link of links) {
    if (link.position === null) continue
    const positions = placed.get(link.book_id) ?? new Set<number>()
    positions.add(link.position)
    placed.set(link.book_id, positions)
  }

  return links.map((link) => {
    const book = books.get(link.book_id) ?? null
    const originalId = book?.canonical_id ?? null
    const original = originalId === null ? undefined : books.get(originalId)
    if (originalId === null || !original) return { position: link.position, book }

    const own = placed.get(originalId)
    const livesElsewhere = own !== undefined && link.position !== null && !own.has(link.position)
    return { position: link.position, book: livesElsewhere ? book : original }
  })
}

async function fetchSeriesBatch(
  token: string,
  ids: number[],
  meter?: Meter,
): Promise<Outcome<Map<number, SeriesNode>>> {
  const list = ids.join(', ')
  const first = await gql<{ series?: SeriesRow[]; book_series?: LinkRow[] }>(
    token,
    `query { series(where: {id: {_in: [${list}]}}) { id name primary_books_count } ` +
      `book_series(where: {series_id: {_in: [${list}]}}, order_by: {position: asc}) { series_id position book_id } }`,
    meter,
  )
  if (!first.ok) return first

  const links = first.data.book_series ?? []
  const bookIds = [...new Set(links.map((link) => link.book_id))]
  const books = new Map<number, BookNode>()
  for (let index = 0; index < bookIds.length; index += BOOKS_PER_FETCH) {
    await delay(MIN_REQUEST_GAP_MS)
    const chunk = bookIds.slice(index, index + BOOKS_PER_FETCH)
    const outcome = await gql<{ books?: (BookNode & { id: number })[] }>(
      token,
      `query { books(where: {id: {_in: [${chunk.join(', ')}]}}) { ${BOOK_FIELDS} } }`,
      meter,
    )
    if (!outcome.ok) return outcome
    for (const book of outcome.data.books ?? []) books.set(book.id, book)
  }

  // Originals that the copies point at and that are not linked to these
  // series themselves. Usually a handful; nothing is sent when there are none.
  const originals = [
    ...new Set(
      [...books.values()]
        .map((book) => book.canonical_id)
        .filter((id): id is number => typeof id === 'number' && !books.has(id)),
    ),
  ]
  for (let index = 0; index < originals.length; index += BOOKS_PER_FETCH) {
    await delay(MIN_REQUEST_GAP_MS)
    const chunk = originals.slice(index, index + BOOKS_PER_FETCH)
    const outcome = await gql<{ books?: (BookNode & { id: number })[] }>(
      token,
      `query { books(where: {id: {_in: [${chunk.join(', ')}]}}) { ${BOOK_FIELDS} } }`,
      meter,
    )
    if (!outcome.ok) return outcome
    for (const book of outcome.data.books ?? []) books.set(book.id, book)
  }

  const out = new Map<number, SeriesNode>()
  for (const row of first.data.series ?? []) {
    out.set(row.id, {
      name: row.name,
      primary_books_count: row.primary_books_count,
      book_series: withOriginals(
        links.filter((link) => link.series_id === row.id),
        books,
      ),
    })
  }
  return { ok: true, data: out }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function resolveSeriesNames(
  queries: SeriesQuery[],
  token: string,
  meter?: Meter,
): Promise<SeriesResult[]> {
  const names = queries.map((item) => item.name)
  const results = new Map<string, SeriesResult>()
  const found: { query: string; id: number; name: string; total: number | null }[] = []

  // Phase 1 — one search per name. Hardcover allows only one search per request.
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]
    if (index > 0) await delay(MIN_REQUEST_GAP_MS)

    const outcome = await searchSeries(token, name, queries[index].author, meter)
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

  // Phase 2 — the series' books, as flat rows (see fetchSeriesBatch).
  for (let index = 0; index < found.length; index += SERIES_PER_FETCH) {
    const batch = found.slice(index, index + SERIES_PER_FETCH)
    await delay(MIN_REQUEST_GAP_MS)
    const outcome = await fetchSeriesBatch(
      token,
      batch.map((item) => item.id),
      meter,
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
      const volumes = node ? editionsByPosition(node) : []
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
