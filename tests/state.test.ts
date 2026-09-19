import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { buildSeriesState } from '../src/state.ts'
import { FUTURE, PAST, TODAY, groupOf, resolved, volume } from './helpers.ts'

/**
 * Every case in "regressions" is a bug that shipped. They are written first
 * because they are the ones with a demonstrated ability to come back.
 */
describe('regressions', () => {
  test('books waiting on the to-read shelf do not count as finished', () => {
    // Shipped as: "3 of 5 read — you've finished it". A queued book is still
    // the answer to "what next"; it is not a handled position.
    const group = groupOf([
      ['read', 'One (Test Series, #1)'],
      ['read', 'Two (Test Series, #2)'],
      ['read', 'Three (Test Series, #3)'],
      ['to_read', 'Four (Test Series, #4)'],
      ['to_read', 'Five (Test Series, #5)'],
    ])
    const volumes = [1, 2, 3, 4, 5].map((n) => volume(n, { releaseDate: PAST }))

    const state = buildSeriesState(group, resolved(volumes, 5), TODAY)

    assert.equal(state.status, 'next_available')
    assert.equal(state.next?.position, 4)
    assert.equal(state.next?.onYourList, true, 'a nudge, not a discovery')
  })

  test('a box set at position 0 is never offered as the next book', () => {
    // Shipped as: "next up — Hunger Games 4-Book Collection".
    const group = groupOf([['read', 'One (Test Series, #1)']])
    const volumes = [
      volume(0, { title: 'Test Series 3-Book Box Set', releaseDate: PAST }),
      volume(1, { releaseDate: PAST }),
      volume(2, { releaseDate: PAST }),
    ]

    const state = buildSeriesState(group, resolved(volumes, 2), TODAY)

    assert.equal(state.next?.position, 2)
    assert.ok(
      state.rows.some((row) => row.position === 0),
      'the box set still belongs in the expanded list, just not as the answer',
    )
  })

  test('a novella at #2.5 is listed but not offered as the next book', () => {
    const group = groupOf([
      ['read', 'One (Test Series, #1)'],
      ['read', 'Two (Test Series, #2)'],
    ])
    const volumes = [volume(1), volume(2), volume(2.5), volume(3)]

    const state = buildSeriesState(group, resolved(volumes, 3), TODAY)

    assert.equal(state.next?.position, 3)
    assert.ok(state.rows.some((row) => row.position === 2.5))
  })
})

describe('status', () => {
  test('a book in progress with nothing left after it reads as reading', () => {
    const group = groupOf([
      ['read', 'One (Test Series, #1)'],
      ['reading', 'Two (Test Series, #2)'],
    ])

    const state = buildSeriesState(group, resolved([volume(1), volume(2)], 2), TODAY)

    assert.equal(state.status, 'reading')
    assert.equal(state.next, null)
  })

  test('a published next volume is next_available', () => {
    const group = groupOf([['read', 'One (Test Series, #1)']])
    const volumes = [volume(1, { releaseDate: PAST }), volume(2, { releaseDate: PAST })]

    const state = buildSeriesState(group, resolved(volumes, 2), TODAY)

    assert.equal(state.status, 'next_available')
    assert.equal(state.next?.publication, 'published')
  })

  test('a dated future volume is waiting/announced', () => {
    const group = groupOf([['read', 'One (Test Series, #1)']])
    const volumes = [volume(1, { releaseDate: PAST }), volume(2, { releaseDate: FUTURE })]

    const state = buildSeriesState(group, resolved(volumes, 2), TODAY)

    assert.equal(state.status, 'waiting')
    assert.equal(state.next?.publication, 'announced')
    assert.equal(state.next?.releaseDate, FUTURE)
  })

  test('an undated volume is waiting/unannounced rather than missing', () => {
    // "No date yet" is a real answer, not a gap.
    const group = groupOf([['read', 'One (Test Series, #1)']])
    const volumes = [volume(1, { releaseDate: PAST }), volume(2, { releaseDate: null })]

    const state = buildSeriesState(group, resolved(volumes, 2), TODAY)

    assert.equal(state.status, 'waiting')
    assert.equal(state.next?.publication, 'unannounced')
  })

  test('every main-line volume read is complete', () => {
    const group = groupOf([
      ['read', 'One (Test Series, #1)'],
      ['read', 'Two (Test Series, #2)'],
    ])

    const state = buildSeriesState(group, resolved([volume(1), volume(2)], 2), TODAY)

    assert.equal(state.status, 'complete')
  })

  test('a DNF closes a position — it is a decision, not a gap', () => {
    const group = groupOf([
      ['read', 'One (Test Series, #1)'],
      ['dnf', 'Two (Test Series, #2)'],
    ])

    const state = buildSeriesState(group, resolved([volume(1), volume(2)], 2), TODAY)

    assert.equal(state.status, 'complete')
    assert.equal(state.suggestDismiss, true, 'a DNF suggests the reader stopped')
  })

  test('a volume list shorter than the series count is partial, not complete', () => {
    const group = groupOf([
      ['read', 'One (Test Series, #1)'],
      ['read', 'Two (Test Series, #2)'],
    ])

    // Hardcover says 5 books but returned 2.
    const state = buildSeriesState(group, resolved([volume(1), volume(2)], 5), TODAY)

    assert.equal(state.status, 'partial')
  })

  test('a reader who has handled more positions than Hardcover lists is complete', () => {
    // Hardcover's volume lists are sometimes shorter than its own count, so
    // the reader's own shelves can settle it.
    const group = groupOf([
      ['read', 'One (Test Series, #1)'],
      ['read', 'Two (Test Series, #2)'],
      ['read', 'Three (Test Series, #3)'],
    ])

    const state = buildSeriesState(group, resolved([volume(1), volume(2)], 3), TODAY)

    assert.equal(state.status, 'complete')
    assert.ok(
      state.rows.some((row) => row.position === 3 && row.mine?.shelf === 'read'),
      'the volume Hardcover omitted still appears, from the library',
    )
  })

  test('an unresolved series is unknown, and still lists what the reader owns', () => {
    const group = groupOf([
      ['read', 'One (Test Series, #1)'],
      ['to_read', 'Two (Test Series, #2)'],
    ])

    const state = buildSeriesState(group, undefined, TODAY)

    assert.equal(state.status, 'unknown')
    assert.equal(state.totalBooks, null)
    assert.equal(state.rows.length, 2)
  })

  test('a next volume with no usable edition is partial, not a crash', () => {
    const group = groupOf([['read', 'One (Test Series, #1)']])
    const volumes = [volume(1), { position: 2, editions: [] }]

    const state = buildSeriesState(group, resolved(volumes, 2), TODAY)

    assert.equal(state.status, 'partial')
    assert.equal(state.next, null)
  })
})

describe('rows', () => {
  test('exactly one row is flagged as next', () => {
    const group = groupOf([['read', 'One (Test Series, #1)']])
    const volumes = [volume(1), volume(2), volume(3)]

    const state = buildSeriesState(group, resolved(volumes, 3), TODAY)

    const flagged = state.rows.filter((row) => row.isNext)
    assert.equal(flagged.length, 1)
    assert.equal(flagged[0].position, 2)
  })

  test('a finished copy outranks a wishlist duplicate at the same position', () => {
    // Goodreads exports often carry two rows for one book.
    const group = groupOf([
      ['to_read', 'One (Test Series, #1)'],
      ['read', 'One (Test Series, #1)'],
    ])

    const state = buildSeriesState(group, resolved([volume(1)], 1), TODAY)

    const row = state.rows.find((r) => r.position === 1)
    assert.equal(row?.mine?.shelf, 'read')
  })

  test('rows come back in position order even when merged from two sources', () => {
    const group = groupOf([
      ['read', 'Three (Test Series, #3)'],
      ['read', 'One (Test Series, #1)'],
    ])

    const state = buildSeriesState(group, resolved([volume(2), volume(1)], 3), TODAY)

    assert.deepEqual(
      state.rows.map((row) => row.position),
      [1, 2, 3],
    )
  })

  test('the cover comes from volume one when it has one', () => {
    const group = groupOf([['read', 'One (Test Series, #1)']])
    const volumes = [
      volume(1, { coverUrl: 'https://example.test/one.jpg' }),
      volume(2, { coverUrl: 'https://example.test/two.jpg' }),
    ]

    const state = buildSeriesState(group, resolved(volumes, 2), TODAY)

    assert.equal(state.coverUrl, 'https://example.test/one.jpg')
  })

  test('the cover falls back to the first volume that has one', () => {
    const group = groupOf([['read', 'One (Test Series, #1)']])
    const volumes = [
      volume(1, { coverUrl: null }),
      volume(2, { coverUrl: 'https://example.test/two.jpg' }),
    ]

    const state = buildSeriesState(group, resolved(volumes, 2), TODAY)

    assert.equal(state.coverUrl, 'https://example.test/two.jpg')
  })
})

describe('editions', () => {
  test('the English edition wins even when another is listed first', () => {
    const group = groupOf([['read', 'One (Test Series, #1)']])
    const volumes = [
      volume(1),
      {
        position: 2,
        editions: [
          { title: 'Zwei', releaseDate: PAST, languageId: 5, readers: 900, coverUrl: null, coverColor: null, slug: null },
          { title: 'Two', releaseDate: PAST, languageId: 1, readers: 10, coverUrl: null, coverColor: null, slug: null },
        ],
      },
    ]

    const state = buildSeriesState(group, resolved(volumes, 2), TODAY)

    assert.equal(state.next?.title, 'Two')
  })

  test('with no English edition it falls back rather than showing nothing', () => {
    const group = groupOf([['read', 'One (Test Series, #1)']])
    const volumes = [
      volume(1),
      {
        position: 2,
        editions: [
          { title: 'Zwei', releaseDate: PAST, languageId: 5, readers: 900, coverUrl: null, coverColor: null, slug: null },
        ],
      },
    ]

    const state = buildSeriesState(group, resolved(volumes, 2), TODAY)

    assert.equal(state.next?.title, 'Zwei')
  })
})

describe('cover placeholder', () => {
  test('the dominant colour rides along with the cover', () => {
    const group = groupOf([['read', 'One (Test Series, #1)']])
    const volumes = [
      volume(1, { coverUrl: 'https://example.test/one.jpg', coverColor: '#2a4b7c' }),
      volume(2),
    ]

    const state = buildSeriesState(group, resolved(volumes, 2), TODAY)

    assert.equal(state.coverColor, '#2a4b7c')
    assert.equal(state.rows[0].coverColor, '#2a4b7c')
  })

  test('a volume the reader owns but Hardcover lacks has no colour', () => {
    const group = groupOf([
      ['read', 'One (Test Series, #1)'],
      ['read', 'Two (Test Series, #2)'],
    ])

    const state = buildSeriesState(group, resolved([volume(1)], 2), TODAY)

    const merged = state.rows.find((row) => row.position === 2)
    assert.equal(merged?.coverColor, null)
  })
})

describe('volumes that are not books', () => {
  /** The real case: Hardcover's Lord of the Rings ends at #4 "Appendices And Index". */
  const appendices = {
    position: 4,
    editions: [
      {
        title: 'Appendices And Index',
        releaseDate: null,
        languageId: 1,
        readers: 2,
        coverUrl: null,
        coverColor: null,
        slug: null,
      },
    ],
  }

  test('a trilogy fully read is finished, not "3 of 4"', () => {
    const group = groupOf([
      ['read', 'One (Test Series, #1)'],
      ['read', 'Two (Test Series, #2)'],
      ['read', 'Three (Test Series, #3)'],
    ])
    const volumes = [volume(1), volume(2), volume(3), appendices]

    const state = buildSeriesState(group, resolved(volumes, 4), TODAY)

    assert.equal(state.status, 'complete')
    assert.equal(state.totalBooks, 3, 'the appendices are not one of the books')
    assert.equal(state.next, null)
    assert.ok(
      state.rows.some((row) => row.position === 4),
      'still listed, just never offered',
    )
  })

  test('an unreleased novel is still offered, despite looking the same', () => {
    // No date, no cover, few readers — identical to the appendices except for
    // the title. This is why all three signals have to agree.
    const group = groupOf([['read', 'One (Test Series, #1)']])
    const volumes = [
      volume(1),
      {
        position: 2,
        editions: [
          {
            title: 'The Winds of Winter',
            releaseDate: null,
            languageId: 1,
            readers: 2,
            coverUrl: null,
            coverColor: null,
            slug: null,
          },
        ],
      },
    ]

    const state = buildSeriesState(group, resolved(volumes, 2), TODAY)

    assert.equal(state.status, 'waiting')
    assert.equal(state.next?.position, 2)
  })

  test('a supplementary title with a cover is treated as a real book', () => {
    // A published companion volume people actually read is not hidden.
    const group = groupOf([['read', 'One (Test Series, #1)']])
    const volumes = [
      volume(1),
      volume(2, { title: 'The Official Companion', coverUrl: 'https://example.test/c.jpg' }),
    ]

    const state = buildSeriesState(group, resolved(volumes, 2), TODAY)

    assert.equal(state.next?.position, 2)
  })
})
