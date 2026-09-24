import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_VISIBLE,
  TILES,
  buildSeriesState,
  countTiles,
  isListed,
  tileOf,
} from '../src/state.ts'
import type { SeriesState } from '../src/state.ts'
import { FUTURE, PAST, TODAY, groupOf, resolved, volume } from './helpers.ts'

const three = [1, 2, 3].map((n) => volume(n, { releaseDate: PAST }))

function readyState(): SeriesState {
  return buildSeriesState(groupOf([['read', 'One (Test Series, #1)']]), resolved(three, 3), TODAY)
}

function finishedState(): SeriesState {
  const group = groupOf([
    ['read', 'One (Test Series, #1)'],
    ['read', 'Two (Test Series, #2)'],
    ['read', 'Three (Test Series, #3)'],
  ])
  return buildSeriesState(group, resolved(three, 3), TODAY)
}

function unknownState(): SeriesState {
  return buildSeriesState(groupOf([['read', 'One (Test Series, #1)']]), undefined, TODAY)
}

describe('tileOf', () => {
  test('a next book that is out files under Ready to read', () => {
    const state = readyState()
    assert.equal(state.status, 'next_available')
    assert.equal(tileOf(state, false), 'ready')
  })

  test('a book in your hands files under Reading now, even with the next one out', () => {
    const group = groupOf([
      ['read', 'One (Test Series, #1)'],
      ['reading', 'Two (Test Series, #2)'],
    ])
    const state = buildSeriesState(group, resolved(three, 3), TODAY)
    assert.equal(state.inProgress, true)
    assert.equal(tileOf(state, false), 'reading')
  })

  test('a next book with a future date files under Waiting on author', () => {
    const volumes = [volume(1, { releaseDate: PAST }), volume(2, { releaseDate: FUTURE })]
    const state = buildSeriesState(groupOf([['read', 'One (Test Series, #1)']]), resolved(volumes, 2), TODAY)
    assert.equal(state.status, 'waiting')
    assert.equal(tileOf(state, false), 'waiting')
  })

  test('a next book with no date at all also waits on the author', () => {
    const volumes = [volume(1, { releaseDate: PAST }), volume(2, { releaseDate: null })]
    const state = buildSeriesState(groupOf([['read', 'One (Test Series, #1)']]), resolved(volumes, 2), TODAY)
    assert.equal(tileOf(state, false), 'waiting')
  })

  test('every book read files under Finished', () => {
    const state = finishedState()
    assert.equal(state.status, 'complete')
    assert.equal(tileOf(state, false), 'finished')
  })

  test('set aside beats what the data says', () => {
    assert.equal(tileOf(readyState(), true), 'aside')
    assert.equal(tileOf(finishedState(), true), 'aside')
  })

  test('a partial series has no tile, so it is always listed', () => {
    const group = groupOf([
      ['read', 'One (Test Series, #1)'],
      ['read', 'Two (Test Series, #2)'],
    ])
    const volumes = [volume(1, { releaseDate: PAST }), volume(2, { releaseDate: PAST })]
    const state = buildSeriesState(group, resolved(volumes, 4), TODAY)
    assert.equal(state.status, 'partial')
    assert.equal(tileOf(state, false), null)
  })

  test('a series not looked up yet has no tile', () => {
    assert.equal(tileOf(unknownState(), false), null)
  })

  test('a failed lookup has no tile even when a DNF set it aside', () => {
    // Hiding a series you have no answer for would lose it without a trace.
    assert.equal(tileOf(unknownState(), true), null)
  })
})

describe('countTiles', () => {
  test('counts add up to every series that has a tile', () => {
    const states = [readyState(), finishedState(), unknownState()].map((state, i) => ({
      ...state,
      key: `s${i}`,
    }))
    const counts = countTiles(states, new Set())
    const total = TILES.reduce((sum, tile) => sum + counts[tile], 0)
    assert.equal(total, 2, 'the unknown series is not on any tile')
    assert.deepEqual(counts, { ready: 1, reading: 0, waiting: 0, finished: 1, aside: 0 })
  })

  test('a set-aside series moves to Set aside instead of counting twice', () => {
    const state = { ...finishedState(), key: 'done' }
    assert.deepEqual(countTiles([state], new Set(['done'])), {
      ready: 0,
      reading: 0,
      waiting: 0,
      finished: 0,
      aside: 1,
    })
  })
})

describe('isListed', () => {
  test('by default, finished and set-aside series are hidden', () => {
    const none = new Set<string>()
    assert.equal(isListed(readyState(), none, DEFAULT_VISIBLE), true)
    assert.equal(isListed(finishedState(), none, DEFAULT_VISIBLE), false)
    const aside = { ...readyState(), key: 'x' }
    assert.equal(isListed(aside, new Set(['x']), DEFAULT_VISIBLE), false)
  })

  test('switching a tile off hides its series', () => {
    const visible = { ...DEFAULT_VISIBLE, ready: false }
    assert.equal(isListed(readyState(), new Set(), visible), false)
  })

  test('a series with no tile is listed even with every tile off', () => {
    const allOff = { ready: false, reading: false, waiting: false, finished: false, aside: false }
    assert.equal(isListed(unknownState(), new Set(), allOff), true)
  })
})
