import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { editionsByPosition, resolveSeriesNames } from '../src/shared/hardcover.ts'
import type { BookNode } from '../src/shared/hardcover.ts'

/** Nesting of selection sets, counting leaf fields; arguments don't count. */
function depthOf(query: string): number {
  let parens = 0
  let depth = 0
  let max = 0
  for (const char of query) {
    if (char === '(') parens += 1
    else if (char === ')') parens -= 1
    else if (parens === 0 && char === '{') max = Math.max(max, (depth += 1))
    else if (parens === 0 && char === '}') depth -= 1
  }
  return max
}

const book = (id: number, title: string, extra: Partial<BookNode> = {}): BookNode & { id: number } => ({
  id,
  title,
  slug: `book-${id}`,
  release_date: '2020-01-01',
  users_read_count: 100,
  image: { url: `https://img.example/${id}.jpg`, color: '#123456' },
  default_ebook_edition: { language_id: 1 },
  default_physical_edition: { language_id: 1 },
  default_audio_edition: { language_id: 1, release_date: '2020-02-01' },
  ...extra,
})

const BOOKS = [
  book(101, 'First'),
  book(102, 'Second', { default_audio_edition: null }),
  book(103, 'Erste', { users_read_count: 3, default_ebook_edition: { language_id: 2 }, default_audio_edition: null }),
]
/** Position 1 holds the original and a translation; position 2 one book. */
const LINKS = [
  { series_id: 7, position: 1, book_id: 101 },
  { series_id: 7, position: 1, book_id: 103 },
  { series_id: 7, position: 2, book_id: 102 },
  { series_id: 7, position: null, book_id: 102 },
]

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function fakeHardcover(sent: string[]) {
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const query = (JSON.parse(init?.body ?? '{}') as { query: string }).query
    sent.push(query)
    let data: unknown
    if (query.includes('search(')) {
      data = { search: { results: { hits: [{ document: { id: '7', name: 'Test Series', primary_books_count: 2, readers_count: 50 } }] } } }
    } else if (query.includes('book_series(')) {
      data = { series: [{ id: 7, name: 'Test Series', primary_books_count: 2 }], book_series: LINKS }
    } else if (query.includes('books(')) {
      data = { books: BOOKS }
    } else {
      throw new Error(`unexpected query: ${query}`)
    }
    return new Response(JSON.stringify({ data }))
  }) as typeof fetch
}

describe('the flat series fetch', () => {
  test('rebuilds the same volumes the nested query gave, in three requests', async () => {
    const sent: string[] = []
    fakeHardcover(sent)
    const meter = { requests: 0 }
    const [result] = await resolveSeriesNames([{ name: 'Test Series' }], 'token', meter)

    // What series → book_series → book used to hand back, built by hand.
    const byId = new Map(BOOKS.map((b) => [b.id, b]))
    const nested = {
      name: 'Test Series',
      primary_books_count: 2,
      book_series: LINKS.map((link) => ({ position: link.position, book: byId.get(link.book_id) ?? null })),
    }

    assert.equal(result.status, 'ok')
    assert.equal(result.matchedName, 'Test Series')
    assert.equal(result.totalBooks, 2)
    assert.deepEqual(result.volumes, editionsByPosition(nested))
    assert.deepEqual(result.volumes.map((v) => v.position), [1, 2])
    assert.deepEqual(result.volumes[0].editions.map((e) => e.title), ['First', 'Erste'])
    assert.equal(result.volumes[0].editions[0].audioDate, '2020-02-01')
    assert.equal(result.volumes[1].editions[0].hasAudio, false)

    assert.equal(meter.requests, 3, 'one search, the links, the books')
    assert.equal(sent.length, 3)
  })

  test('no query sent to Hardcover nests deeper than three', async () => {
    const sent: string[] = []
    fakeHardcover(sent)
    await resolveSeriesNames([{ name: 'Test Series' }], 'token')
    for (const query of sent) {
      assert.ok(depthOf(query) <= 3, `depth ${depthOf(query)}: ${query.slice(0, 80)}`)
    }
    // The checker itself: the query this replaced was four levels by the
    // loosest count and five by the strictest.
    assert.equal(depthOf('query { series_by_pk(id: 1) { book_series(order_by: {position: asc}) { book { default_ebook_edition { language_id } } } } }'), 5)
  })

  test('ties do not depend on the order Hardcover returns rows in', () => {
    // Two translations nobody has logged, same position, same language.
    const a = book(201, 'Zweite Ausgabe', { users_read_count: 0, default_ebook_edition: { language_id: 51 }, default_audio_edition: null })
    const b = book(202, 'Erste Ausgabe', { users_read_count: 0, default_ebook_edition: { language_id: 51 }, default_audio_edition: null })
    const c = book(203, 'Édition', { users_read_count: 0, default_ebook_edition: { language_id: 30 }, default_audio_edition: null })
    const node = (books: BookNode[]) => ({
      name: 'S',
      primary_books_count: 1,
      book_series: books.map((entry) => ({ position: 1, book: entry })),
    })
    const forward = editionsByPosition(node([a, b, c]))
    const backward = editionsByPosition(node([c, b, a]))
    assert.deepEqual(forward, backward)
    // The older record (lower id) is kept; equal readers sort by language id.
    assert.deepEqual(forward[0].editions.map((e) => e.title), ['Édition', 'Zweite Ausgabe'])
  })

  test('a book that never arrives leaves a gap, not a crash', async () => {
    const sent: string[] = []
    fakeHardcover(sent)
    BOOKS.pop()
    const [result] = await resolveSeriesNames([{ name: 'Test Series' }], 'token')
    assert.deepEqual(result.volumes[0].editions.map((e) => e.title), ['First'])
  })
})
