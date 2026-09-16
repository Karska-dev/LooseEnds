import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { buildSeriesState, sortSeriesStates } from '../src/state.ts'
import type { SeriesState } from '../src/state.ts'
import { FUTURE, PAST, TODAY, groupOf, resolved, volume } from './helpers.ts'

/** Each builder produces one series in a named state, under its own name. */
const make = {
  reading: () =>
    buildSeriesState(
      groupOf([
        ['read', 'One (Reading, #1)'],
        ['reading', 'Two (Reading, #2)'],
      ]),
      resolved([volume(1), volume(2)], 2),
      TODAY,
    ),

  announced: () =>
    buildSeriesState(
      groupOf([['read', 'One (Announced, #1)']]),
      resolved([volume(1, { releaseDate: PAST }), volume(2, { releaseDate: FUTURE })], 2),
      TODAY,
    ),

  available: () =>
    buildSeriesState(
      groupOf([['read', 'One (Available, #1)']]),
      resolved([volume(1, { releaseDate: PAST }), volume(2, { releaseDate: PAST })], 2),
      TODAY,
    ),

  unannounced: () =>
    buildSeriesState(
      groupOf([['read', 'One (Unannounced, #1)']]),
      resolved([volume(1, { releaseDate: PAST }), volume(2, { releaseDate: null })], 2),
      TODAY,
    ),

  partial: () =>
    buildSeriesState(
      groupOf([['read', 'One (Partial, #1)']]),
      resolved([volume(1)], 9),
      TODAY,
    ),

  unknown: () =>
    buildSeriesState(groupOf([['read', 'One (Unknown, #1)']]), undefined, TODAY),

  complete: () =>
    buildSeriesState(
      groupOf([['read', 'One (Complete, #1)']]),
      resolved([volume(1)], 1),
      TODAY,
    ),
}

describe('sort order', () => {
  test('attention order: in your hands, then dates, then what you can start tonight', () => {
    const states = [
      make.complete(),
      make.unknown(),
      make.partial(),
      make.unannounced(),
      make.available(),
      make.announced(),
      make.reading(),
    ]

    const sorted = sortSeriesStates(states).map((state) => state.status)

    assert.deepEqual(sorted, [
      'reading',
      'waiting', // announced — a date you are waiting on
      'next_available', // out now, start tonight
      'waiting', // unannounced — nothing to act on
      'partial',
      'unknown',
      'complete',
    ])
  })

  test('an announced date sorts ahead of an undated series', () => {
    const sorted = sortSeriesStates([make.unannounced(), make.announced()])

    assert.equal(sorted[0].next?.publication, 'announced')
    assert.equal(sorted[1].next?.publication, 'unannounced')
  })

  test('sooner release dates come first', () => {
    const soon = buildSeriesState(
      groupOf([['read', 'One (Soon, #1)']]),
      resolved([volume(1, { releaseDate: PAST }), volume(2, { releaseDate: '2026-08-01' })], 2),
      TODAY,
    )
    const later = buildSeriesState(
      groupOf([['read', 'One (Later, #1)']]),
      resolved([volume(1, { releaseDate: PAST }), volume(2, { releaseDate: '2027-08-01' })], 2),
      TODAY,
    )

    const sorted = sortSeriesStates([later, soon])

    assert.deepEqual(
      sorted.map((state) => state.next?.releaseDate),
      ['2026-08-01', '2027-08-01'],
    )
  })

  test('sorting does not mutate the input', () => {
    const states: SeriesState[] = [make.complete(), make.reading()]
    const before = states.map((state) => state.status)

    sortSeriesStates(states)

    assert.deepEqual(states.map((state) => state.status), before)
  })
})

describe('open design question', () => {
  /**
   * Pins today's behaviour rather than endorsing it. A reader part-way
   * through book 2 of 5 gets `next_available` — the same rank as a series
   * they have not opened in a year — because `reading` is only reported when
   * nothing is left after the book in progress. Whether a series with a book
   * actually in hand should outrank one merely available is a product call,
   * not a bug fix, so it is documented here until it is made.
   */
  test('a book in progress mid-series does not currently rank as reading', () => {
    const group = groupOf([
      ['read', 'One (Midway, #1)'],
      ['reading', 'Two (Midway, #2)'],
      ['to_read', 'Three (Midway, #3)'],
    ])

    const state = buildSeriesState(
      group,
      resolved([volume(1), volume(2), volume(3)], 3),
      TODAY,
    )

    assert.equal(state.status, 'next_available')
    assert.equal(state.next?.position, 3)
  })
})
