import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { groupIntoSeries } from '../src/series.ts'
import { booksOf } from './helpers.ts'

describe('books with no series', () => {
  test('a standalone title is reported, not dropped', () => {
    const summary = groupIntoSeries(
      booksOf([
        ['read', 'Piranesi'],
        ['read', 'One (Test Series, #1)'],
      ]),
    )

    assert.equal(summary.unmatched.length, 1)
    assert.equal(summary.unmatched[0].title, 'Piranesi')
    assert.equal(summary.matchRate, 0.5)
  })

  test('an imprint in parentheses is not mistaken for a series', () => {
    // "(Vintage International)" has no #, so it is a publisher, not a series.
    const summary = groupIntoSeries(booksOf([['read', 'Beloved (Vintage International)']]))

    assert.equal(summary.groups.length, 0)
    assert.equal(summary.unmatched.length, 1)
  })

  test('a title keeps its own parentheses', () => {
    const summary = groupIntoSeries(
      booksOf([['read', 'The Fall (A Novel) (Test Series, #2)']]),
    )

    assert.equal(summary.groups[0].entries[0].cleanTitle, 'The Fall (A Novel)')
  })

  test('an empty library reports a zero match rate rather than NaN', () => {
    const summary = groupIntoSeries([])

    assert.equal(summary.matchRate, 0)
    assert.equal(summary.unmatched.length, 0)
  })

  test('every book lands in exactly one of grouped or unmatched', () => {
    const books = booksOf([
      ['read', 'One (Test Series, #1)'],
      ['read', 'Piranesi'],
      ['to_read', 'Two (Test Series, #2)'],
      ['dnf', 'Beloved (Vintage International)'],
    ])

    const summary = groupIntoSeries(books)
    const grouped = summary.groups.reduce((n, group) => n + group.entries.length, 0)

    assert.equal(grouped + summary.unmatched.length, books.length)
  })
})

describe('grouping', () => {
  test('a leading "The" does not split one series into two', () => {
    const summary = groupIntoSeries(
      booksOf([
        ['read', 'One (The Stormlight Archive, #1)'],
        ['read', 'Two (Stormlight Archive, #2)'],
      ]),
    )

    assert.equal(summary.groups.length, 1)
    assert.equal(summary.groups[0].readCount, 2)
  })

  test('an omnibus is flagged rather than treated as one volume', () => {
    const summary = groupIntoSeries(booksOf([['read', 'Boxed Set (Test Series, #1-3)']]))

    assert.equal(summary.groups[0].entries[0].isOmnibus, true)
  })

  test('read count, highest position and DNF are tracked per series', () => {
    const summary = groupIntoSeries(
      booksOf([
        ['read', 'One (Test Series, #1)'],
        ['read', 'Three (Test Series, #3)'],
        ['dnf', 'Four (Test Series, #4)'],
        ['to_read', 'Five (Test Series, #5)'],
      ]),
    )

    const group = summary.groups[0]
    assert.equal(group.readCount, 2)
    assert.equal(group.highestReadPosition, 3)
    assert.equal(group.hasDnf, true)
  })

  test('a half-numbered novella keeps its fractional position', () => {
    const summary = groupIntoSeries(booksOf([['read', 'Novella (Test Series, #2.5)']]))

    assert.equal(summary.groups[0].entries[0].position, 2.5)
  })
})

describe('inconsistent series names', () => {
  test('singular and plural spellings become one series', () => {
    // The real case: Goodreads tags book 1 "Drixonian Warriors" and the
    // novella "Drixonian Warrior".
    const summary = groupIntoSeries(
      booksOf([
        ['read', "The Alien's Ransom (Drixonian Warriors, #1)", { author: 'Ella Maven' }],
        ['read', "The Alien's Future (Drixonian Warrior, #0.5)", { author: 'Ella Maven' }],
        ['read', "The Alien's Escape (Drixonian Warriors, #2)", { author: 'Ella Maven' }],
      ]),
    )

    assert.equal(summary.groups.length, 1)
    assert.equal(summary.groups[0].readCount, 3)
    assert.equal(summary.groups[0].name, 'Drixonian Warriors', 'the common spelling wins')
    assert.equal(summary.groups[0].key, 'drixonian warriors')
  })

  test('the merged group sees every read position', () => {
    // Split, each half offered a book the other had finished.
    const summary = groupIntoSeries(
      booksOf([
        ['read', 'One (Test Warriors, #1)'],
        ['read', 'Two (Test Warrior, #2)'],
      ]),
    )

    assert.equal(summary.groups[0].highestReadPosition, 2)
  })

  test('the same plural by different authors stays two series', () => {
    const summary = groupIntoSeries(
      booksOf([
        ['read', 'One (Shadows, #1)', { author: 'Author One' }],
        ['read', 'One (Shadow, #1)', { author: 'Author Two' }],
      ]),
    )

    assert.equal(summary.groups.length, 2)
  })

  test('a word whose ending only looks plural is left alone', () => {
    // "Chaos" and "Bliss" must not become "Chao" and "Blis".
    const summary = groupIntoSeries(
      booksOf([
        ['read', 'One (Chaos, #1)'],
        ['read', 'One (Bliss, #1)'],
        ['read', 'One (Atlas, #1)'],
      ]),
    )

    assert.equal(summary.groups.length, 3)
  })

  test('short words keep their s', () => {
    // "Ops" must not become "Op".
    const summary = groupIntoSeries(
      booksOf([
        ['read', 'One (Ops, #1)'],
        ['read', 'One (Op, #1)'],
      ]),
    )

    assert.equal(summary.groups.length, 2)
  })
})
