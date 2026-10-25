import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  NO_DECISIONS,
  bookKey,
  booksByMonth,
  bracket,
  decisionsFor,
  pairKey,
  parseYearBook,
  pickDuel,
  pickMonth,
  readYears,
  undoDuel,
  serializeYearBook,
  withDecisions,
} from '../src/yearBook.ts'
import type { YearDecisions } from '../src/yearBook.ts'
import type { Book } from '../src/goodreads.ts'
import { booksOf } from './helpers.ts'

/** A finished book: made-up title, read on the given day of 2026. */
function read(title: string, date: string, extra: Partial<Book> = {}): Book {
  return booksOf([['read', title, { dateRead: date, ...extra }]])[0]!
}

/** Twelve month lists with the given books in the given months (1..12). */
function year(spec: Record<number, string[]>): Book[][] {
  return Array.from({ length: 12 }, (_, i) =>
    (spec[i + 1] ?? []).map((title) => read(title, `2026-${String(i + 1).padStart(2, '0')}-10`)),
  )
}

const titleOf = (book: Book | null | undefined) => book?.title ?? null
const find = (months: Book[][], title: string) => months.flat().find((b) => b.title === title)!

/** Answers every question with the first book offered, until nothing is asked. */
function playFirst(months: Book[][], start: YearDecisions = NO_DECISIONS) {
  let decisions = start
  for (let guard = 0; guard < 100; guard++) {
    const b = bracket(months, decisions)
    if (!b.next) return { decisions, result: b }
    decisions =
      b.next.kind === 'month'
        ? pickMonth(decisions, b.next.month, b.next.books[0]!)
        : pickDuel(decisions, b.next.a, b.next.b, b.next.a)
  }
  throw new Error('the bracket never finished')
}

describe('booksByMonth', () => {
  test('puts read books in their month, in date order', () => {
    const books = [read('Late', '2026-03-20'), read('Early', '2026-03-02'), read('Jan', '2026-01-31')]
    const months = booksByMonth(books, 2026)
    assert.deepEqual(months[2]!.map((b) => b.title), ['Early', 'Late'])
    assert.deepEqual(months[0]!.map((b) => b.title), ['Jan'])
    assert.equal(months.length, 12)
  })

  test('31 Dec and 1 Jan belong to their own years', () => {
    const books = [read('New Year’s Eve', '2026-12-31'), read('New Year’s Day', '2027-01-01'), read('Before', '2025-12-31')]
    const months = booksByMonth(books, 2026)
    assert.deepEqual(months[11]!.map((b) => b.title), ['New Year’s Eve'])
    assert.equal(months.flat().length, 1)
    assert.equal(booksByMonth(books, 2027)[0]!.length, 1)
  })

  test('leaves out other shelves, DNF, missing and malformed dates', () => {
    const books = [
      read('Kept', '2026-05-05'),
      ...booksOf([
        ['dnf', 'Abandoned', { dateRead: '2026-05-06' }],
        ['reading', 'Now', { dateRead: '2026-05-07' }],
        ['to_read', 'Later'],
        ['read', 'Undated', { dateRead: null }],
        ['read', 'Odd month', { dateRead: '2026-13-01' }],
        ['read', 'Odd text', { dateRead: 'May 2026' }],
      ]),
    ]
    assert.deepEqual(booksByMonth(books, 2026).flat().map((b) => b.title), ['Kept'])
  })

  test('the same book twice counts once, at its earlier date', () => {
    const books = [
      read('Twice', '2026-08-01', { isbn13: '9780000000001' }),
      read('Twice (reread)', '2026-02-01', { isbn13: '9780000000001' }),
      read('Same words', '2026-04-01', { title: 'Same words', author: 'A' }),
      read('Same words', '2026-06-01', { title: ' same  WORDS ', author: 'a' }),
    ]
    const months = booksByMonth(books, 2026)
    assert.deepEqual(months[1]!.map((b) => b.title), ['Twice (reread)'])
    assert.equal(months[7]!.length, 0)
    assert.equal(months[3]!.length + months[5]!.length, 1)
  })

  test('different books with one title stay apart', () => {
    const books = [
      read('Echo', '2026-01-01', { author: 'A' }),
      read('Echo', '2026-01-02', { author: 'B' }),
    ]
    assert.equal(booksByMonth(books, 2026)[0]!.length, 2)
  })
})

describe('readYears', () => {
  test('lists years with finished dated books, newest first', () => {
    const books = [read('a', '2024-01-01'), read('b', '2026-06-01'), read('c', '2026-07-01'), ...booksOf([['to_read', 'x']])]
    assert.deepEqual(readYears(books), [2026, 2024])
    assert.deepEqual(readYears([]), [])
  })
})

describe('bookKey and pairKey', () => {
  test('ISBN wins; otherwise title and author, ignoring case and spacing', () => {
    assert.equal(bookKey(read('x', '2026-01-01', { isbn13: '9781' })), 'isbn:9781')
    const a = read('x', '2026-01-01', { title: 'The  Book', author: 'Ann ' })
    const b = read('x', '2026-02-01', { title: 'the book', author: 'ann' })
    assert.equal(bookKey(a), bookKey(b))
  })

  test('a pair has one key whichever way round', () => {
    const a = read('A', '2026-01-01')
    const b = read('B', '2026-02-01')
    assert.equal(pairKey(a, b), pairKey(b, a))
  })
})

describe('bracket: skipping and defaults', () => {
  test('no books: nothing to ask and no winner', () => {
    const b = bracket(year({}), NO_DECISIONS)
    assert.equal(b.next, null)
    assert.equal(b.winner, null)
  })

  test('a single book in the whole year wins by default', () => {
    const b = bracket(year({ 7: ['Only'] }), NO_DECISIONS)
    assert.equal(b.next, null)
    assert.equal(titleOf(b.winner), 'Only')
    assert.equal(titleOf(b.quarters[2]), 'Only')
    assert.equal(titleOf(b.halves[1]), 'Only')
    assert.equal(b.quarters[0], null)
  })

  test('one book per month: no month picks, only duels', () => {
    const months = year({ 1: ['J'], 2: ['F'], 3: ['M'] })
    const b = bracket(months, NO_DECISIONS)
    assert.equal(b.next?.kind, 'duel')
    assert.ok(b.months.every((m) => !m.needsPick))
  })

  test('a quarter with a single filled month needs no duel', () => {
    const b = bracket(year({ 2: ['Feb'], 10: ['Oct'] }), NO_DECISIONS)
    // Q1 and Q4 are settled by default; the only question is the year duel.
    assert.equal(b.next?.kind, 'duel')
    assert.equal(b.next?.kind === 'duel' && b.next.stage, 'year')
  })

  test('months without a pick are asked first, in month order, before any duel', () => {
    const months = year({ 1: ['a1', 'a2'], 2: ['b'], 5: ['c1', 'c2', 'c3'] })
    const first = bracket(months, NO_DECISIONS)
    assert.deepEqual(first.next && first.next.kind === 'month' && first.next.month, 1)
    const afterJan = bracket(months, pickMonth(NO_DECISIONS, 1, find(months, 'a2')))
    assert.deepEqual(afterJan.next && afterJan.next.kind === 'month' && afterJan.next.month, 5)
  })
})

describe('bracket: playing through', () => {
  const months = year({ 1: ['Jan'], 2: ['Feb'], 3: ['Mar'], 4: ['Apr'], 5: ['May'], 6: ['Jun'], 7: ['Jul'], 8: ['Aug'], 9: ['Sep'], 10: ['Oct'], 11: ['Nov'], 12: ['Dec'] })

  test('a full year is 11 duels, and the winner stays on within a quarter', () => {
    let decisions = NO_DECISIONS
    let duels = 0
    const stages: string[] = []
    for (;;) {
      const b = bracket(months, decisions)
      if (!b.next) break
      assert.equal(b.next.kind, 'duel')
      if (b.next.kind !== 'duel') break
      duels++
      stages.push(b.next.stage)
      decisions = pickDuel(decisions, b.next.a, b.next.b, b.next.a)
    }
    assert.equal(duels, 11)
    assert.deepEqual(stages, ['quarter', 'quarter', 'quarter', 'quarter', 'quarter', 'quarter', 'quarter', 'quarter', 'half', 'half', 'year'])
    assert.equal(titleOf(bracket(months, decisions).winner), 'Jan')
  })

  test('duels are shown in calendar order', () => {
    const b = bracket(months, NO_DECISIONS)
    assert.ok(b.next?.kind === 'duel')
    assert.deepEqual([b.next.a.title, b.next.b.title], ['Jan', 'Feb'])
    const second = bracket(months, pickDuel(NO_DECISIONS, find(months, 'Jan'), find(months, 'Feb'), find(months, 'Feb')))
    assert.ok(second.next?.kind === 'duel')
    assert.deepEqual([second.next.a.title, second.next.b.title], ['Feb', 'Mar'])
  })

  test('the reader can pick the later book every time', () => {
    let decisions = NO_DECISIONS
    for (;;) {
      const b = bracket(months, decisions)
      if (!b.next || b.next.kind !== 'duel') break
      decisions = pickDuel(decisions, b.next.a, b.next.b, b.next.b)
    }
    assert.equal(titleOf(bracket(months, decisions).winner), 'Dec')
  })
})

describe('bracket: changing an earlier pick', () => {
  const months = year({ 1: ['J1', 'J2'], 2: ['F'], 3: ['M'], 4: ['A'] })

  test('a later duel between the same two books keeps its answer', () => {
    // J1 is picked in January; F beats J1; M beats F: March wins the quarter.
    let d = pickMonth(NO_DECISIONS, 1, find(months, 'J1'))
    d = pickDuel(d, find(months, 'J1'), find(months, 'F'), find(months, 'F'))
    d = pickDuel(d, find(months, 'F'), find(months, 'M'), find(months, 'M'))
    assert.equal(titleOf(bracket(months, d).quarters[0]), 'M')
    // Change January to J2: J2 vs F is new, but F vs M was answered already.
    const changed = pickMonth(d, 1, find(months, 'J2'))
    const b = bracket(months, changed)
    assert.ok(b.next?.kind === 'duel')
    assert.deepEqual([b.next.a.title, b.next.b.title], ['J2', 'F'])
    const answered = bracket(months, pickDuel(changed, find(months, 'J2'), find(months, 'F'), find(months, 'F')))
    assert.equal(titleOf(answered.quarters[0]), 'M')
  })

  test('changing a pick back finds the old answer waiting', () => {
    let d = pickMonth(NO_DECISIONS, 1, find(months, 'J1'))
    d = pickDuel(d, find(months, 'J1'), find(months, 'F'), find(months, 'J1'))
    const back = pickMonth(pickMonth(d, 1, find(months, 'J2')), 1, find(months, 'J1'))
    assert.deepEqual(bracket(months, back), bracket(months, d))
  })

  test('a saved pick for a book no longer in the month is no pick', () => {
    const gone = pickMonth(NO_DECISIONS, 1, read('Removed from export', '2026-01-05'))
    const b = bracket(months, gone)
    assert.equal(b.months[0]!.needsPick, true)
    assert.equal(b.next?.kind, 'month')
  })

  test('an answer naming neither book in the pair is ignored', () => {
    const a = find(months, 'F')
    const m = find(months, 'M')
    const bad: YearDecisions = { months: {}, duels: { [pairKey(a, m)]: 'isbn:nobody' } }
    const stray = bracket(year({ 2: ['F'], 3: ['M'] }), bad)
    assert.equal(stray.next?.kind, 'duel')
  })
})

describe('bracket: progress and undo', () => {
  const months = year({ 1: ['a'], 2: ['b'], 3: ['c'], 7: ['d'] })

  test('a year takes one duel fewer than it has months with books', () => {
    assert.deepEqual(bracket(months, NO_DECISIONS).duels, { answered: 0, total: 3 })
    assert.deepEqual(bracket(year({ 5: ['x', 'y'] }), NO_DECISIONS).duels, { answered: 0, total: 0 })
    assert.deepEqual(bracket(year({}), NO_DECISIONS).duels, { answered: 0, total: 0 })
  })

  test('answered counts up to the total, one per answer', () => {
    let d = NO_DECISIONS
    for (let step = 0; step < 3; step++) {
      const b = bracket(months, d)
      assert.equal(b.duels.answered, step)
      assert.ok(b.next?.kind === 'duel')
      d = pickDuel(d, b.next.a, b.next.b, b.next.a)
    }
    const end = bracket(months, d)
    assert.deepEqual(end.duels, { answered: 3, total: 3 })
    assert.equal(end.next, null)
  })

  test('undoing an answer asks that pair again', () => {
    const a = find(months, 'a')
    const b = find(months, 'b')
    const answered = pickDuel(NO_DECISIONS, a, b, b)
    const back = undoDuel(answered, b, a)
    assert.deepEqual(back, NO_DECISIONS)
    assert.equal(undoDuel(back, a, b), back)
  })
})

describe('bracket: finishing', () => {
  test('answering every question leaves a winner and no next', () => {
    const months = year({ 1: ['a', 'b', 'c'], 2: ['d'], 5: ['e', 'f'], 11: ['g'] })
    const { result } = playFirst(months)
    assert.equal(result.next, null)
    assert.ok(result.winner)
  })

  test('the winner is always one of the books read', () => {
    const months = year({ 3: ['x', 'y'], 9: ['z'] })
    const { result } = playFirst(months)
    assert.ok(months.flat().some((b) => bookKey(b) === bookKey(result.winner!)))
  })

  test('the runner-up is the loser of the final, never the winner', () => {
    const months = year({ 1: ['a'], 4: ['b'], 8: ['c'], 12: ['d'] })
    const { result } = playFirst(months)
    assert.ok(result.runnerUp)
    assert.notEqual(bookKey(result.runnerUp!), bookKey(result.winner!))
    assert.equal(result.runnerUp!.title, 'c')
  })

  test('placings: runner-up first, then quarter picks, then month favourites', () => {
    const months = year({ 1: ['a'], 2: ['b'], 3: ['c'], 4: ['d'], 7: ['e'], 8: ['f'], 12: ['g'] })
    const { result } = playFirst(months)
    // First answer always wins: a takes Q1 and the half; e takes Q3 and the final.
    assert.equal(titleOf(result.winner), 'a')
    assert.deepEqual(
      result.placings.map((p) => [p.book.title, p.tier, p.at]),
      [
        ['e', 'runnerUp', 0],
        ['d', 'quarter', 2],
        ['g', 'quarter', 4],
        ['c', 'month', 3], // lost the second duel of its quarter: got further than b
        ['b', 'month', 2],
        ['f', 'month', 8],
      ],
    )
  })

  test('placings never contain the winner, and count n − 1 once finished', () => {
    const months = year({ 1: ['a', 'b'], 2: ['c'], 6: ['d'], 9: ['e', 'f'], 10: ['g'] })
    const { result } = playFirst(months)
    assert.equal(result.placings.length, result.duels.total)
    assert.ok(result.placings.every((p) => bookKey(p.book) !== bookKey(result.winner!)))
  })

  test('no runner-up while the final is open, or when the winner won by default', () => {
    const months = year({ 1: ['a'], 4: ['b'] })
    assert.equal(bracket(months, NO_DECISIONS).runnerUp, null)
    const lone = year({ 3: ['a', 'b'] })
    assert.equal(playFirst(lone).result.runnerUp, null)
    assert.equal(bracket(year({}), NO_DECISIONS).runnerUp, null)
  })
})

describe('storage', () => {
  test('nothing, bad JSON and bad shapes are no decisions', () => {
    for (const raw of [null, '', '{nope', '42', '"x"', '{"years":[]}', '{"years":"a"}', '{"v":1}']) {
      assert.deepEqual(parseYearBook(raw), {})
    }
  })

  test('round-trips', () => {
    const a = read('A', '2026-01-01')
    const b = read('B', '2026-01-02')
    let d = pickMonth(NO_DECISIONS, 1, a)
    d = pickDuel(d, a, b, b)
    const saved = withDecisions({}, 2026, d)
    assert.deepEqual(parseYearBook(serializeYearBook(saved)), saved)
    assert.deepEqual(decisionsFor(saved, 2026), d)
    assert.equal(decisionsFor(saved, 2025), NO_DECISIONS)
  })

  test('drops junk: bad years, bad months, non-text answers, empty years', () => {
    const raw = JSON.stringify({
      v: 1,
      years: {
        '2026': { months: { '1': 'k', '0': 'x', '13': 'y', '05': 'z', '3': 7 }, duels: { p: 'k', q: '', r: null } },
        'abc': { months: { '1': 'k' }, duels: {} },
        '2025': { months: {}, duels: {} },
        '2024': 'nope',
      },
    })
    assert.deepEqual(parseYearBook(raw), { '2026': { months: { '1': 'k' }, duels: { p: 'k' } } })
  })

  test('withDecisions removes a year that has no decisions left', () => {
    const saved = withDecisions({}, 2026, { months: { '1': 'k' }, duels: {} })
    assert.deepEqual(withDecisions(saved, 2026, NO_DECISIONS), {})
  })
})
