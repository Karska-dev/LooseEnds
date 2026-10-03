import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { aiFailureKind, alignToAiTitles, buildAiSeriesState, stopsTheRun } from '../src/aiState.ts'
import { NOTHING_RELEVANT, TOO_FEW_BOOKS } from '../src/shared/aiLookup.ts'
import type { AiSeriesResult, AiVolume } from '../src/shared/aiLookup.ts'
import { TODAY, groupOf } from './helpers.ts'

/** One book as the AI lookup returns it. */
function book(position: number, title: string, releaseDate: string | null = '2020', extra: Partial<AiVolume['editions'][number]> = {}): AiVolume {
  return {
    position,
    editions: [
      { title, releaseDate, languageId: null, readers: 0, coverUrl: null, coverColor: null, slug: null, hasAudio: false, audio: null, ...extra },
    ],
    evidence: { url: `https://author.example/books#${position}`, dateVerified: true, positionFrom: 'pages' },
  }
}

function found(volumes: AiVolume[], extra: Partial<AiSeriesResult> = {}): AiSeriesResult {
  return {
    query: 'Test Series',
    matchedName: 'Test Series',
    hardcoverId: null,
    totalBooks: volumes.filter((volume) => Number.isInteger(volume.position)).length,
    volumes,
    status: 'ok',
    source: 'ai',
    checkedAt: '2026-06-10',
    readingOrder: null,
    ...extra,
  }
}

function missed(detail: string, status: 'not_found' | 'error' = 'not_found', extra: Partial<AiSeriesResult> = {}): AiSeriesResult {
  return { ...found([]), status, detail, ...extra }
}

const positions = (group: ReturnType<typeof groupOf>) =>
  group.entries.map((entry) => [entry.cleanTitle, entry.position])

describe('matching the reader\'s books to an AI list by title', () => {
  test('a list that counts a novella as a whole book does not shift what was read', () => {
    // The reason this exists. Goodreads: Prize is #5. This list: the holiday
    // novella is #5 and everything after it is one higher.
    const group = groupOf([
      ['read', 'Ice Planet Barbarians (Test Series, #1)'],
      ['read', 'Barbarian Alien (Test Series, #2)'],
      ['read', 'Barbarian Lover (Test Series, #3)'],
      ['read', 'Barbarian Mine (Test Series, #4)'],
      ['read', "Barbarian's Prize (Test Series, #5)"],
    ])
    const list = found([
      book(1, 'Ice Planet Barbarians'),
      book(2, 'Barbarian Alien'),
      book(3, 'Barbarian Lover'),
      book(4, 'Barbarian Mine'),
      book(5, 'Ice Planet Holiday'),
      book(6, "Barbarian's Prize"),
      book(7, "Barbarian's Mate"),
    ])

    const state = buildAiSeriesState(group, list, TODAY)

    const prize = state.rows.find((row) => row.title === "Barbarian's Prize")
    assert.equal(prize?.position, 6)
    assert.equal(prize?.mine?.shelf, 'read', 'the book the reader finished is the one marked read')
    assert.equal(state.rows.find((row) => row.title === 'Ice Planet Holiday')?.mine, null, 'not the novella that took its number')
    assert.equal(state.next?.title, 'Ice Planet Holiday', 'the first book on the list not read')
  })

  test('case, punctuation, accents and a leading "The" do not stop a match', () => {
    const group = groupOf([
      ['read', 'The Cruel Prince (Test Series, #1)'],
      ['read', 'Déjà Vu, Again! (Test Series, #2)'],
    ])
    const aligned = alignToAiTitles(group, found([book(1, 'Cruel Prince'), book(2, 'Deja vu again')]))
    assert.deepEqual(positions(aligned), [['The Cruel Prince', 1], ['Déjà Vu, Again!', 2]])
  })

  test('a subtitle or an edition note on either side does not stop a match', () => {
    const group = groupOf([
      ['read', 'Fourth Wing: Special Edition (Test Series, #1)'],
      ['read', 'Iron Flame (Test Series, #2)'],
    ])
    const aligned = alignToAiTitles(group, found([book(1, 'Fourth Wing'), book(2, 'Iron Flame (Deluxe Edition)')]))
    assert.deepEqual(positions(aligned), [['Fourth Wing: Special Edition', 1], ['Iron Flame', 2]])
  })

  test('a whole-title match is preferred to a shortened one', () => {
    const group = groupOf([['read', 'Bride (Test Series, #1)']])
    const aligned = alignToAiTitles(group, found([book(0.5, 'Bride: The Prequel'), book(1, 'Bride'), book(2, 'Mate')]))
    assert.deepEqual(positions(aligned), [['Bride', 1]])
  })

  test('a title the list words differently falls back to its number', () => {
    // The US and UK titles of one book: nothing to match on but the number.
    const group = groupOf([
      ["read", "Harry Potter and the Sorcerer's Stone (Test Series, #1)"],
      ['read', 'Harry Potter and the Chamber of Secrets (Test Series, #2)'],
    ])
    const list = found([
      book(1, "Harry Potter and the Philosopher's Stone"),
      book(2, 'Harry Potter and the Chamber of Secrets'),
      book(3, 'Harry Potter and the Prisoner of Azkaban'),
    ])
    const state = buildAiSeriesState(group, list, TODAY)
    assert.equal(state.rows[0].mine?.shelf, 'read')
    assert.equal(state.rows[0].mine?.title, "Harry Potter and the Sorcerer's Stone")
    assert.equal(state.next?.position, 3)
  })

  test('but never onto a number that is, by title, another of the reader\'s books', () => {
    // "Side Story" is #3 on Goodreads and not on the list at all; the list's
    // #3 is a book the reader has under #4. It must not be marked twice.
    const group = groupOf([
      ['read', 'One (Test Series, #1)'],
      ['read', 'Side Story (Test Series, #3)'],
      ['to_read', 'Three (Test Series, #4)'],
    ])
    const list = found([book(1, 'One'), book(2, 'Two'), book(3, 'Three'), book(4, 'Four')])

    const aligned = alignToAiTitles(group, list)
    assert.deepEqual(positions(aligned), [['One', 1], ['Three', 3], ['Side Story', null]])

    const state = buildAiSeriesState(group, list, TODAY)
    assert.equal(state.rows.find((row) => row.position === 3)?.mine?.shelf, 'to_read')
    assert.equal(state.next?.position, 2)
  })

  test('a book the list does not have, at a number the list does not use, is still shown', () => {
    const group = groupOf([
      ['read', 'One (Test Series, #1)'],
      ['read', 'A Christmas Extra (Test Series, #1.5)'],
    ])
    const state = buildAiSeriesState(group, found([book(1, 'One'), book(2, 'Two')]), TODAY)
    assert.deepEqual(state.rows.map((row) => row.position), [1, 1.5, 2])
    assert.equal(state.rows[1].mine?.title, 'A Christmas Extra')
  })

  test('the reader\'s own group is not changed', () => {
    const group = groupOf([['read', 'Two (Test Series, #1)']])
    alignToAiTitles(group, found([book(1, 'One'), book(2, 'Two')]))
    assert.equal(group.entries[0].position, 1)
  })
})

describe('what the AI tab says about a series', () => {
  const group = groupOf([
    ['read', 'One (Test Series, #1)'],
    ['read', 'Two (Test Series, #2)'],
  ])

  test('a found series carries its source pages, audiobook details and reading order', () => {
    const list = found(
      [
        book(1, 'One', '2019', { hasAudio: true, audio: { year: '2020', publisher: 'Tantor Audio' } }),
        book(2, 'Two', '2020'),
        book(3, 'Three', '2021'),
      ],
      { readingOrder: { note: 'Read the novella after book two.', url: 'https://author.example/order' } },
    )
    const state = buildAiSeriesState(group, list, TODAY)

    assert.equal(state.status, 'next_available')
    assert.equal(state.totalBooks, 3)
    assert.equal(state.rows[0].sourceUrl, 'https://author.example/books#1')
    assert.deepEqual(state.rows[0].audio, { year: '2020', publisher: 'Tantor Audio' })
    assert.equal(state.rows[1].audio, undefined)
    assert.deepEqual(state.ai, {
      checkedAt: '2026-06-10',
      readingOrder: { note: 'Read the novella after book two.', url: 'https://author.example/order' },
      miss: null,
      retryAfter: null,
    })
  })

  test('an undated next book is out if the lookup worked out that it must be', () => {
    const undated = buildAiSeriesState(group, found([book(1, 'One'), book(2, 'Two'), book(3, 'Three', null)]), TODAY)
    assert.equal(undated.status, 'waiting')
    assert.equal(undated.next?.publication, 'unannounced')

    const inferred = buildAiSeriesState(
      group,
      found([book(1, 'One'), book(2, 'Two'), book(3, 'Three', null, { releasedInferred: true }), book(4, 'Four', '2024')]),
      TODAY,
    )
    assert.equal(inferred.status, 'next_available')
    assert.equal(inferred.next?.title, 'Three')
    assert.equal(inferred.rows[2].publication, 'published')
  })

  test('a year alone is enough to tell out from announced', () => {
    const state = buildAiSeriesState(group, found([book(1, 'One'), book(2, 'Two'), book(3, 'Three', '2027')]), TODAY)
    assert.equal(state.status, 'waiting')
    assert.equal(state.next?.publication, 'announced')
  })

  test('not asked about yet: no list, and nothing to say', () => {
    const state = buildAiSeriesState(group, undefined, TODAY)
    assert.equal(state.status, 'unknown')
    assert.deepEqual(state.ai, { checkedAt: null, readingOrder: null, miss: null, retryAfter: null })
    assert.equal(state.rows.length, 2, 'the reader\'s own books are still listed')
  })

  test('each kind of miss is told apart', () => {
    const missOf = (result: AiSeriesResult) => buildAiSeriesState(group, result, TODAY).ai?.miss
    assert.equal(missOf(missed(TOO_FEW_BOOKS)), 'not_confirmed')
    assert.equal(missOf(missed(NOTHING_RELEVANT)), 'not_found')
    assert.equal(missOf(missed('no pages with text')), 'not_found')
    assert.equal(missOf(missed('Daily AI lookup limit reached', 'error')), 'allowance')
    assert.equal(missOf(missed('AI lookup is out of searches for this month', 'error')), 'month')
    assert.equal(missOf(missed('AI lookup could not be reached', 'error')), 'failed')
  })

  test('a miss says when it will be tried again', () => {
    const state = buildAiSeriesState(group, missed(TOO_FEW_BOOKS, 'not_found', { retryAfter: '2026-06-24' }), TODAY)
    assert.equal(state.status, 'unknown')
    assert.equal(state.ai?.retryAfter, '2026-06-24')
  })
})

describe('why a lookup stopped', () => {
  test('the server\'s words are read into the page\'s terms', () => {
    assert.equal(aiFailureKind('Daily AI lookup limit reached'), 'budget')
    assert.equal(aiFailureKind('AI lookup is out of searches for this month'), 'month')
    assert.equal(aiFailureKind('AI lookup is not configured on this server.'), 'unset')
    assert.equal(aiFailureKind('Lookups are not configured on this server.'), 'unset')
    assert.equal(aiFailureKind('Couldn’t confirm you’re a person'), 'check')
    assert.equal(aiFailureKind('Too many lookups. Try again in a minute.'), 'busy')
    assert.equal(aiFailureKind('AI lookup could not be reached'), 'unreachable')
    assert.equal(aiFailureKind('HTTP 502 (not JSON)'), 'unreachable')
    assert.equal(aiFailureKind(null), 'unreachable')
  })

  test('only a failure that may pass by itself lets the run carry on', () => {
    assert.equal(stopsTheRun('unreachable'), false)
    for (const kind of ['budget', 'month', 'unset', 'check', 'busy'] as const) assert.equal(stopsTheRun(kind), true)
  })
})
