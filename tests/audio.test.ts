import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { audioNote, buildSeriesState } from '../src/state.ts'
import { hasUnreleasedVolume, predatesAudioDates } from '../worker/cache.ts'
import { FUTURE, PAST, TODAY, groupOf, resolved, volume } from './helpers.ts'

const LATER = '2027-09-01'

describe('audioNote: only a future audiobook that says something new', () => {
  test('ebook out, audiobook to come', () => {
    assert.equal(audioNote(PAST, FUTURE, TODAY), FUTURE)
  })
  test('nothing when the audiobook is out, missing, or on the same day', () => {
    assert.equal(audioNote(PAST, PAST, TODAY), null)
    assert.equal(audioNote(PAST, null, TODAY), null)
    assert.equal(audioNote(PAST, undefined, TODAY), null)
    assert.equal(audioNote(FUTURE, FUTURE, TODAY), null)
  })
  test('said when the audiobook comes before or after an announced book', () => {
    assert.equal(audioNote(FUTURE, LATER, TODAY), LATER)
    assert.equal(audioNote(LATER, FUTURE, TODAY), FUTURE)
  })
  test('said when only the audiobook has a date', () => {
    assert.equal(audioNote(null, FUTURE, TODAY), FUTURE)
  })
})

describe('status follows what there is to read; audio is extra', () => {
  const group = () => groupOf([['read', 'One (Test Series, #1)']])

  test('next book out as an ebook, audiobook later: still ready, with the audio date', () => {
    const state = buildSeriesState(
      group(),
      resolved([volume(1, { releaseDate: PAST }), volume(2, { releaseDate: PAST, audioDate: FUTURE })]),
      TODAY,
    )
    assert.equal(state.status, 'next_available')
    assert.equal(state.next?.audioDate, FUTURE)
    assert.equal(state.rows.find((row) => row.position === 2)?.audioDate, FUTURE)
  })

  test('no audiobook data: nothing extra', () => {
    const state = buildSeriesState(
      group(),
      resolved([volume(1, { releaseDate: PAST }), volume(2, { releaseDate: PAST })]),
      TODAY,
    )
    assert.equal(state.next?.audioDate, null)
  })

  test('an announced book with the audiobook the same day says the date once', () => {
    const state = buildSeriesState(
      group(),
      resolved([volume(1, { releaseDate: PAST }), volume(2, { releaseDate: FUTURE, audioDate: FUTURE })]),
      TODAY,
    )
    assert.equal(state.status, 'waiting')
    assert.equal(state.next?.audioDate, null)
  })
})

describe('hasAudio: any audiobook, out or announced', () => {
  const group = () => groupOf([['read', 'One (Test Series, #1)']])
  test('marked when it exists, dated or not, and when only a date is known', () => {
    const state = buildSeriesState(
      group(),
      resolved([
        volume(1, { releaseDate: PAST, hasAudio: true, audioDate: PAST }),
        volume(2, { releaseDate: PAST, hasAudio: true, audioDate: null }),
        volume(3, { releaseDate: PAST, hasAudio: false, audioDate: null }),
        volume(4, { releaseDate: PAST, audioDate: FUTURE }),
      ]),
      TODAY,
    )
    assert.deepEqual(state.rows.map((row) => row.hasAudio), [true, true, false, true])
  })
})

describe('cache', () => {
  test('a released series with an audiobook still to come is re-checked daily', () => {
    const released = resolved([volume(1, { releaseDate: PAST, audioDate: null })])
    const audioToCome = resolved([volume(1, { releaseDate: PAST, audioDate: FUTURE })])
    assert.equal(hasUnreleasedVolume(released, TODAY), false)
    assert.equal(hasUnreleasedVolume(audioToCome, TODAY), true)
  })

  test('entries cached before audiobook dates are refetched once', () => {
    assert.equal(predatesAudioDates(resolved([volume(1)])), true)
    assert.equal(predatesAudioDates(resolved([volume(1, { audioDate: null })])), true)
    assert.equal(predatesAudioDates(resolved([volume(1, { audioDate: null, hasAudio: false })])), false)
    assert.equal(predatesAudioDates(resolved([])), false)
  })
})
