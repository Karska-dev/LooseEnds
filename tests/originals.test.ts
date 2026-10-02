import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { editionsByPosition, resolveSeriesNames, withOriginals } from '../src/shared/hardcover.ts'
import type { BookNode } from '../src/shared/hardcover.ts'

const ENGLISH = 1

/** A real record: tagged, read. */
const original = (id: number, title: string, readers: number): BookNode & { id: number } => ({
  id,
  title,
  slug: `book-${id}`,
  release_date: '2006-01-01',
  users_read_count: readers,
  image: null,
  default_ebook_edition: { language_id: ENGLISH },
  default_physical_edition: null,
  default_audio_edition: null,
  canonical_id: null,
})

/** A copy: no language, nobody has read it, points at the original. */
const copy = (id: number, title: string, of: number | null): BookNode & { id: number } => ({
  id,
  title,
  slug: null,
  release_date: '2006-04-22',
  users_read_count: 0,
  image: null,
  default_ebook_edition: null,
  default_physical_edition: null,
  default_audio_edition: null,
  canonical_id: of,
})

const shelf = (...books: (BookNode & { id: number })[]) => new Map<number, BookNode>(books.map((b) => [b.id, b]))

/** Hardcover's "Dune" on 2026-10-02, positions 6 to 8, ids as they are there. */
const CHAPTERHOUSE = original(439821, 'Chapterhouse: Dune', 726)
const HUNTERS = original(439865, 'Hunters of Dune', 164)
const SANDWORMS = original(446812, 'Sandworms of Dune', 145)
const DUNE_LINKS = [
  { position: 6, book_id: 439821 },
  { position: 7, book_id: 2455981 },
  { position: 7, book_id: 2343340 },
  { position: 7, book_id: 2730157 },
  { position: 8, book_id: 2730155 },
  { position: 8, book_id: 1709525 },
  { position: 8, book_id: 2343341 },
  { position: null, book_id: 446812 },
  { position: null, book_id: 439865 },
]
const DUNE_BOOKS = shelf(
  CHAPTERHOUSE,
  HUNTERS,
  SANDWORMS,
  copy(2455981, 'Hunters Of Dune', 439865),
  copy(2343340, 'Łowcy Diuny', 439865),
  copy(2730157, 'I cacciatori di Dune', 439865),
  copy(2730155, 'I vermi della sabbia di Dune', 446812),
  { ...copy(1709525, 'The Dune Audio Collection', null), users_read_count: 1 },
  copy(2343341, 'Czerwie Diuny', 446812),
)

const shown = (links: typeof DUNE_LINKS, books: Map<number, BookNode>) =>
  editionsByPosition({ name: 'S', primary_books_count: null, book_series: withOriginals(links, books) }).map(
    (volume) => [volume.position, (volume.editions.find((e) => e.languageId === ENGLISH) ?? volume.editions[0]).title],
  )

describe('copies stand for their originals', () => {
  test('Dune #7 and #8 are Hunters and Sandworms, not a Polish copy and an audio bundle', () => {
    assert.deepEqual(shown(DUNE_LINKS, DUNE_BOOKS), [
      [6, 'Chapterhouse: Dune'],
      [7, 'Hunters of Dune'],
      [8, 'Sandworms of Dune'],
    ])
  })

  test('without the originals it is what readers saw before', () => {
    const copiesOnly = new Map([...DUNE_BOOKS].map(([id, b]) => [id, { ...b, canonical_id: null }]))
    assert.deepEqual(shown(DUNE_LINKS, copiesOnly)[1], [7, 'Łowcy Diuny'])
  })

  test('a misfiled copy does not move a book that has its own place', () => {
    // "Dune 2" sits at #1 and is a copy of "Dune Messiah", which is #2.
    const dune = original(312460, 'Dune', 8489)
    const messiah = original(427393, 'Dune Messiah', 9000)
    const links = [
      { position: 1, book_id: 312460 },
      { position: 1, book_id: 1886843 },
      { position: 2, book_id: 427393 },
    ]
    const books = shelf(dune, messiah, copy(1886843, 'Dune 2', 427393))
    assert.deepEqual(shown(links, books), [
      [1, 'Dune'],
      [2, 'Dune Messiah'],
    ])
  })

  test('a copy beside its original at the same position changes nothing', () => {
    const links = [
      { position: 6, book_id: 439821 },
      { position: 6, book_id: 2126168 },
    ]
    const books = shelf(CHAPTERHOUSE, copy(2126168, 'La rifondazione di Dune', 439821))
    const volumes = editionsByPosition({ name: 'S', primary_books_count: null, book_series: withOriginals(links, books) })
    assert.equal(volumes.length, 1)
    assert.deepEqual(volumes[0].editions.map((e) => e.title), ['Chapterhouse: Dune'])
  })

  test('an original that was never fetched leaves the copy as it is', () => {
    const links = [{ position: 7, book_id: 2343340 }]
    assert.deepEqual(shown(links, shelf(copy(2343340, 'Łowcy Diuny', 439865))), [[7, 'Łowcy Diuny']])
  })
})

describe('fetching the originals', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  /** The series links only copies; the original is not linked to it at all. */
  function fakeHardcover(sent: string[], failOriginals = false) {
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      const query = (JSON.parse(init?.body ?? '{}') as { query: string }).query
      sent.push(query)
      let data: unknown
      if (query.includes('search(')) {
        data = { search: { results: { hits: [{ document: { id: '7', name: 'Robots', primary_books_count: 1, readers_count: 50 } }] } } }
      } else if (query.includes('book_series(')) {
        data = { series: [{ id: 7, name: 'Robots', primary_books_count: 1 }], book_series: [{ series_id: 7, position: 4, book_id: 500 }] }
      } else if (query.includes('_in: [500]')) {
        data = { books: [copy(500, 'Der Aufbruch zu den Sternen', 41)] }
      } else if (query.includes('_in: [41]')) {
        if (failOriginals) return new Response(JSON.stringify({ errors: [{ message: 'boom' }] }))
        data = { books: [original(41, 'The Robots of Dawn', 900)] }
      } else {
        throw new Error(`unexpected query: ${query}`)
      }
      return new Response(JSON.stringify({ data }))
    }) as typeof fetch
  }

  test('one more request, and the English title is shown', async () => {
    const sent: string[] = []
    fakeHardcover(sent)
    const meter = { requests: 0 }
    const [result] = await resolveSeriesNames([{ name: 'Robots' }], 'token', meter)

    assert.equal(meter.requests, 4, 'the search, the links, the books, the originals')
    assert.ok(sent[2].includes('canonical_id'), 'the books are asked what they are copies of')
    assert.deepEqual(result.volumes.map((v) => [v.position, v.editions[0].title, v.editions[0].languageId]), [
      [4, 'The Robots of Dawn', ENGLISH],
    ])
  })

  test('if the originals cannot be fetched the series is an error, not a half answer to cache', async () => {
    const sent: string[] = []
    fakeHardcover(sent, true)
    const [result] = await resolveSeriesNames([{ name: 'Robots' }], 'token')
    assert.equal(result.status, 'error')
    assert.deepEqual(result.volumes, [])
  })
})
