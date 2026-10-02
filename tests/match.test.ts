import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  bestHit,
  bestHitByAuthor,
  byAnotherAuthor,
  nameCloseness,
  resolveSeriesNames,
} from '../src/shared/hardcover.ts'

const hit = (name: string, author: string, books: number, readers: number, id = name) => ({
  id,
  name,
  author_name: author,
  primary_books_count: books,
  readers_count: readers,
})

/** What Hardcover really returned for "Foundation" on 2026-10-02. */
const FOUNDATION = [
  hit('Foundation', 'Isaac Asimov', 7, 11159),
  hit('Foundation', 'Gregory Benford', 0, 0, 'benford'),
  hit('Greater Foundation Universe', 'Isaac Asimov', 15, 12715),
  hit('Foundation (Chronological Order)', 'Isaac Asimov', 7, 11165),
  hit('Razorland', 'Ann Aguirre', 4, 259),
  hit('Foundation Universe', 'Isaac Asimov', 13, 3898),
  hit('Second Foundation Trilogy', 'David Brin', 3, 201),
  hit('Mass Effect: Foundation', 'Mac Walters', 9, 24),
]

describe('nameCloseness', () => {
  test('the same name, give or take case and punctuation', () => {
    assert.equal(nameCloseness('Foundation', 'foundation'), 0)
    assert.equal(nameCloseness("The Hitchhiker's Guide to the Galaxy", 'The Hitchhiker’s Guide to the Galaxy'), 0)
  })
  test('the same but for words like The, Saga, Series', () => {
    assert.equal(nameCloseness('The Mistborn Saga', 'Mistborn'), 1)
    assert.equal(nameCloseness('The Expanse', 'Expanse Series'), 1)
  })
  test('a superset or a variant is only related', () => {
    assert.equal(nameCloseness('Greater Foundation Universe', 'Foundation'), 2)
    assert.equal(nameCloseness('Foundation (Chronological Order)', 'Foundation'), 2)
    assert.equal(nameCloseness('The Series', 'The Saga'), 2, 'nothing left to compare')
  })
})

describe('bestHit', () => {
  test('"Foundation" means Foundation, not the universe that contains it', () => {
    const winner = bestHit(FOUNDATION, 'Foundation', 'Isaac Asimov')
    assert.equal(winner?.name, 'Foundation')
    assert.equal(winner?.author_name, 'Isaac Asimov')
  })

  test('without an author it is still the exact name, and never the empty shell', () => {
    const winner = bestHit(FOUNDATION, 'Foundation')
    assert.equal(winner?.name, 'Foundation')
    assert.equal(winner?.primary_books_count, 7)
  })

  test('no exact name: the one that differs only by generic words', () => {
    const hits = [
      hit('The Cosmere', 'Brandon Sanderson', 34, 73000),
      hit('The Mistborn Saga', 'Brandon Sanderson', 10, 32000),
      hit('Mistborn: Wax & Wayne', 'Brandon Sanderson', 4, 9000),
    ]
    assert.equal(bestHit(hits, 'Mistborn', 'Brandon Sanderson')?.name, 'The Mistborn Saga')
  })

  test('an exact-named near-empty duplicate does not beat the real series', () => {
    const hits = [
      hit('Dune', 'Frank Herbert', 1, 3, 'shell'),
      hit('Dune Chronicles', 'Frank Herbert', 6, 40000),
    ]
    assert.equal(bestHit(hits, 'Dune', 'Frank Herbert')?.name, 'Dune Chronicles')
  })

  test('nothing close: the most-read related series, as before', () => {
    const hits = [
      hit('Discworld - Ankh-Morpork City Watch', 'Terry Pratchett', 8, 9000),
      hit('Discworld - Death', 'Terry Pratchett', 5, 7000),
    ]
    assert.equal(bestHit(hits, 'Discworld', 'Terry Pratchett')?.name, 'Discworld - Ankh-Morpork City Watch')
  })

  test('the author still decides between same-named series', () => {
    const hits = [hit('Villain', 'A. Writer', 3, 9000, 'a'), hit('Villain', 'B. Author', 3, 200, 'b')]
    assert.equal(bestHit(hits, 'Villain', 'B. Author')?.id, 'b')
  })
})

/**
 * What Hardcover really returned for "Legacy" on 2026-10-02: a full page of
 * series called exactly "Legacy", none by the reader's author.
 */
const LEGACY = [
  hit('Legacy', 'Catherine Coulter', 3, 85, 'coulter'),
  hit('Legacy', 'Cayla Kluver', 2, 40, 'kluver'),
  hit('Legacy', 'Rebecca Yarros', 1, 34, 'yarros'),
  hit('Legacy', 'Gerald Welch', 8, 6, 'welch'),
  hit('Legacy', 'McKenzie Hunter', 4, 22, 'hunter'),
  hit('Legacy', 'Ryan Attard', 0, 0, 'attard'),
]
/** The search for "Legacy Melissa K. Roehrich": hers, and her other series. */
const LEGACY_BY_AUTHOR = [
  hit('Lady of Darkness', 'Melissa K. Roehrich', 5, 4000, 'darkness'),
  hit('The Legacy Series', 'Melissa K. Roehrich', 4, 900, 'roehrich'),
]

describe('a name shared by more series than one page of hits', () => {
  test('the first pick is by somebody else, and says so', () => {
    const pick = bestHit(LEGACY, 'Legacy', 'Melissa K. Roehrich')
    assert.equal(pick?.id, 'coulter')
    assert.equal(byAnotherAuthor(pick, 'Melissa K. Roehrich'), true)
  })

  test('a pick by the reader\'s author asks for nothing more', () => {
    assert.equal(byAnotherAuthor(bestHit(FOUNDATION, 'Foundation', 'Isaac Asimov'), 'Isaac Asimov'), false)
    assert.equal(byAnotherAuthor(bestHit(FOUNDATION, 'Foundation'), undefined), false, 'no author known')
    assert.equal(byAnotherAuthor(null, 'Isaac Asimov'), false, 'nothing found at all')
  })

  test('the search with the author finds her series, not her most-read one', () => {
    assert.equal(bestHitByAuthor(LEGACY_BY_AUTHOR, 'Legacy', 'Melissa K. Roehrich')?.id, 'roehrich')
  })

  test('the author\'s other series are not an answer', () => {
    const others = [hit('Lady of Darkness', 'Melissa K. Roehrich', 5, 4000)]
    assert.equal(bestHitByAuthor(others, 'Legacy', 'Melissa K. Roehrich'), null)
  })

  test('nor is the right name by the wrong author, or an empty shell', () => {
    assert.equal(bestHitByAuthor(LEGACY, 'Legacy', 'Melissa K. Roehrich'), null)
    const shell = [hit('The Legacy Series', 'Melissa K. Roehrich', 0, 0)]
    assert.equal(bestHitByAuthor(shell, 'Legacy', 'Melissa K. Roehrich'), null)
  })
})

describe('the second search', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  /** Answers searches from `pages` in order; series and books are empty. */
  function fakeSearches(pages: ReturnType<typeof hit>[][], sent: string[]) {
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      const query = (JSON.parse(init?.body ?? '{}') as { query: string }).query
      sent.push(query)
      const data = query.includes('search(')
        ? { search: { results: { hits: (pages.shift() ?? []).map((document) => ({ document })) } } }
        : { series: [], book_series: [], books: [] }
      return new Response(JSON.stringify({ data }))
    }) as typeof fetch
  }
  const numbered = (hits: ReturnType<typeof hit>[]) => hits.map((entry, index) => ({ ...entry, id: String(index + 1) }))
  const searches = (sent: string[]) => sent.filter((query) => query.includes('search('))

  test('is sent with the author\'s name, and its pick is the one resolved', async () => {
    const sent: string[] = []
    fakeSearches([numbered(LEGACY), numbered(LEGACY_BY_AUTHOR).map((entry) => ({ ...entry, id: `9${entry.id}` }))], sent)
    const [result] = await resolveSeriesNames([{ name: 'Legacy', author: 'Melissa K. Roehrich' }], 'token')

    assert.equal(searches(sent).length, 2)
    assert.ok(searches(sent)[1].includes('search(query: "Legacy Melissa K. Roehrich"'))
    assert.equal(result.hardcoverId, 92, 'The Legacy Series, from the second search')
  })

  test('keeps the first pick when the author\'s series is not there either', async () => {
    const sent: string[] = []
    fakeSearches([numbered(LEGACY), []], sent)
    const [result] = await resolveSeriesNames([{ name: 'Legacy', author: 'Melissa K. Roehrich' }], 'token')
    assert.equal(searches(sent).length, 2)
    assert.equal(result.hardcoverId, 1, 'a co-author or a pen name is still a match')
  })

  test('is not sent when the first search found the author, or no author is known', async () => {
    const sent: string[] = []
    fakeSearches([numbered(FOUNDATION), numbered(FOUNDATION)], sent)
    await resolveSeriesNames([{ name: 'Foundation', author: 'Isaac Asimov' }, { name: 'Foundation' }], 'token')
    assert.equal(searches(sent).length, 2, 'one each')
  })
})
