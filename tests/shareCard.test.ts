import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { QUIET_LIGHT, SIZES, fitText, layoutCard, mix } from '../src/shareCard.ts'
import type { CardBook, CardSpec, FontSpec, Op, Shape } from '../src/shareCard.ts'
import { TINTS, tintFor, tintIndex } from '../src/tint.ts'

/** A pretend ruler: every letter is half as wide as the type is tall. */
const ruler = (text: string, font: FontSpec) => [...text].length * font.size * 0.5
const widthOf = (text: string, size: number) => [...text].length * size * 0.5

const book = (title: string, tint = 1): CardBook => ({ title, author: 'Lena Park', tint })

const spec = (over: Partial<CardSpec> = {}): CardSpec => ({
  format: 'winner',
  shape: 'story',
  palette: QUIET_LIGHT,
  label: 'Best of 2026',
  stat: '1 of 198 books I read in 2026',
  winner: book('Wolfsong Road'),
  ...over,
})

const SHAPES: Shape[] = ['story', 'post', 'square']

describe('mix', () => {
  test('0 % is the ground and 100 % is the colour', () => {
    assert.equal(mix('#3b4a9e', 0, '#f1f3f7'), '#f1f3f7')
    assert.equal(mix('#3b4a9e', 100, '#f1f3f7'), '#3b4a9e')
  })

  test('half way between white and black is the Oklab grey, as in CSS color-mix', () => {
    // color-mix(in oklab, white 50%, black) is rgb(99 99 99); plain RGB would give 128.
    assert.equal(mix('#ffffff', 50, '#000000'), '#636363')
  })

  test('a 14 % tint is a light version of the colour, not the colour', () => {
    const tint = mix('#3b4a9e', 14, '#f1f3f7')
    assert.match(tint, /^#[0-9a-f]{6}$/)
    assert.notEqual(tint, '#3b4a9e')
    assert.notEqual(tint, '#f1f3f7')
  })
})

describe('fitText', () => {
  const opts = { maxWidth: 100, maxLines: 2, size: 20, minSize: 8, step: 2 }

  test('short text stays on one line at full size', () => {
    assert.deepEqual(fitText(widthOf, 'Short', opts), { lines: ['Short'], size: 20 })
  })

  test('wraps by words', () => {
    const fit = fitText(widthOf, 'One two three four', { ...opts, maxLines: 4 })
    assert.equal(fit.size, 20)
    assert.deepEqual(fit.lines, ['One two', 'three four'])
    assert.equal(fit.lines.join(' '), 'One two three four')
    assert.ok(fit.lines.every((line) => widthOf(line, fit.size) <= 100))
  })

  test('shrinks until it fits in the lines allowed', () => {
    const fit = fitText(widthOf, 'A fairly long book title indeed', opts)
    assert.ok(fit.size < 20)
    assert.ok(fit.lines.length <= 2)
    assert.ok(fit.lines.every((line) => widthOf(line, fit.size) <= 100))
  })

  test('at the smallest size, the rest is cut with an ellipsis, never drawn outside', () => {
    const long = 'word '.repeat(60).trim()
    const fit = fitText(widthOf, long, opts)
    assert.equal(fit.size, 8)
    assert.equal(fit.lines.length, 2)
    assert.ok(fit.lines[1]!.endsWith('…'))
    assert.ok(fit.lines.every((line) => widthOf(line, fit.size) <= 100))
  })

  test('a single word wider than the line is broken by letters', () => {
    const fit = fitText(widthOf, 'Supercalifragilisticexpialidocious', { ...opts, maxLines: 6, size: 20, minSize: 20 })
    assert.ok(fit.lines.length > 1)
    assert.equal(fit.lines.join(''), 'Supercalifragilisticexpialidocious')
    assert.ok(fit.lines.every((line) => widthOf(line, 20) <= 100))
  })

  test('Cyrillic and empty text are handled', () => {
    assert.deepEqual(fitText(widthOf, 'Книга', opts).lines, ['Книга'])
    assert.deepEqual(fitText(widthOf, '', opts).lines, [''])
  })
})

describe('tint index', () => {
  test('is stable, in range, and the page tint is the one at that index', () => {
    for (const name of ['isbn:9781', 'Wolfsong Road', 'Книга', '']) {
      assert.equal(tintIndex(name), tintIndex(name))
      assert.ok(tintIndex(name) >= 0 && tintIndex(name) < TINTS.length)
      assert.equal(tintFor(name), TINTS[tintIndex(name)])
    }
  })
})

const texts = (ops: Op[]) => ops.filter((op): op is Extract<Op, { kind: 'text' }> => op.kind === 'text')
const covers = (ops: Op[]) => ops.filter((op): op is Extract<Op, { kind: 'cover' }> => op.kind === 'cover')
const lines = (ops: Op[]) => ops.filter((op): op is Extract<Op, { kind: 'line' }> => op.kind === 'line')
const bounds = (ops: Op[]) =>
  texts(ops).map((op) => {
    const w = ruler(op.text, op.font) + (op.tracking > 0 ? op.tracking * op.text.length : 0)
    const left = op.align === 'left' ? op.x : op.align === 'right' ? op.x - w : op.x - w / 2
    return { op, left, right: left + w, bottom: op.top + op.lineHeight }
  })

const QUARTERS = ['Q1 book', 'Q2 book', 'Q3 book', 'Q4 book'].map((t, i) => book(t, i))
const HALVES = [book('Half one', 2), book('Half two', 3)]
const treeSpec = (over: Partial<CardSpec> = {}) =>
  spec({
    format: 'quarters',
    quarters: QUARTERS,
    halves: HALVES,
    quarterNames: ['Q1', 'Q2', 'Q3', 'Q4'],
    ...over,
  })

const MONTH_BOOKS = Array.from({ length: 12 }, (_, i) => book(`Month ${i + 1} book`, i))
const fullSpec = (over: Partial<CardSpec> = {}) =>
  treeSpec({ format: 'full', months: MONTH_BOOKS, monthLetters: [...'JFMAMJJASOND'], ...over })
const PLACINGS = [
  ['Runner-up', 'Runner-up'], ['Q1 pick', 'Q1 pick'], ['Q4 pick', 'Q4 pick'], ['March', 'March'],
  ['February', 'February'], ['December', 'December'], ['November', 'November'], ['August', 'August'], ['January', 'January'],
].map(([title, label], i) => ({ book: book(title!, i), label: label! }))
const tiersSpec = (format: 'top5' | 'top10', over: Partial<CardSpec> = {}) =>
  spec({ format, placings: PLACINGS, ...over })

describe('layoutCard: every shape', () => {
  test('the picture is the size of its shape, a ground first and the winner marked once', () => {
    for (const shape of SHAPES) {
      for (const s of [spec({ shape }), treeSpec({ shape }), fullSpec({ shape }), tiersSpec('top5', { shape }), tiersSpec('top10', { shape })]) {
        const ops = layoutCard(s, ruler)
        const { width, height } = SIZES[shape]
        assert.deepEqual(ops[0], { kind: 'fill', x: 0, y: 0, w: width, h: height, color: QUIET_LIGHT.ground })
        assert.equal(ops.filter((op) => op.kind === 'crown').length, 1, `${shape} ${s.format}`)
        assert.equal(ops.filter((op) => op.kind === 'frame').length, 1)
      }
    }
    assert.deepEqual(SIZES.story, { width: 1080, height: 1920 })
    assert.equal(SIZES.post.height / SIZES.post.width, 1.25)
    assert.equal(SIZES.square.height, SIZES.square.width)
  })

  test('all text and covers stay inside the picture, for short, long and Cyrillic titles', () => {
    const titles = [
      'Wolfsong Road',
      'The Long Thaw of the Small Gods of Lisbon and the Seven Doors to Nowhere, Part Two',
      'Supercalifragilisticexpialidocious',
      'Хроніки Нескінченного Саду та Вітру, що Забув Дорогу Додому',
      'A'.repeat(300),
    ]
    for (const shape of SHAPES) {
      const { width, height } = SIZES[shape]
      for (const title of titles) {
        const long = { ...book(title), author: 'Дуже Довге Ім’я Автора '.repeat(4) }
        const longer = (b: CardBook) => ({ ...b, title, author: long.author })
        const rows = PLACINGS.map((r) => ({ ...r, book: longer(r.book), label: 'A tier label that is far too long to fit on one line of the list' }))
        for (const s of [
          spec({ shape, winner: long }),
          treeSpec({ shape, winner: long, quarters: QUARTERS.map(longer) }),
          fullSpec({ shape, winner: long, months: MONTH_BOOKS.map(longer), quarters: QUARTERS.map(longer) }),
          tiersSpec('top5', { shape, winner: long, placings: rows }),
          tiersSpec('top10', { shape, winner: long, placings: rows }),
        ]) {
          const ops = layoutCard(s, ruler)
          for (const b of bounds(ops)) {
            assert.ok(b.left >= 0 && b.right <= width, `${shape}/${s.format}: "${b.op.text.slice(0, 20)}" runs outside (${b.left}..${b.right})`)
            assert.ok(b.op.top >= 0 && b.bottom <= height, `${shape}/${s.format}: text off the bottom`)
          }
          for (const c of covers(ops)) assert.ok(c.x >= 0 && c.x + c.w <= width && c.y >= 0 && c.y + c.h <= height)
        }
      }
    }
  })

  test('the label is shown in capitals, spaced out', () => {
    const label = texts(layoutCard(spec(), ruler)).find((op) => op.tracking > 0)!
    assert.equal(label.text, 'BEST OF 2026')
  })

  test('the small print keeps to the edges, in every shape', () => {
    for (const shape of SHAPES) {
      const { height } = SIZES[shape]
      for (const op of texts(layoutCard(spec({ shape }), ruler)).filter((o) => o.text === 'Loose Ends' || o.tracking > 0)) {
        assert.ok(op.top < height * 0.1 || op.top > height * 0.9, `${shape}: ${op.text} at ${op.top}`)
      }
    }
  })
})

describe('layoutCard: winner only', () => {
  test('the cover is centred, 2:3, and drawn in the tint of the book', () => {
    for (const shape of SHAPES) {
      const [c] = covers(layoutCard(spec({ shape, winner: book('X', 2) }), ruler))
      assert.equal(c!.x + c!.w / 2, 540)
      assert.equal(c!.h, c!.w * 1.5)
      assert.equal(c!.fill, mix(QUIET_LIGHT.tints[2], 14, QUIET_LIGHT.ground))
    }
  })

  test('the author sits below the title, which sits below the cover', () => {
    const ops = layoutCard(spec({ winner: book('The Long Thaw of the Small Gods of Lisbon and More') }), ruler)
    const [c] = covers(ops)
    const under = texts(ops).filter((op) => op.align === 'center' && op.top > c!.y + c!.h)
    const author = under.find((op) => op.text === 'Lena Park')!
    const titleLines = under.filter((op) => op !== author)
    assert.ok(titleLines.length >= 1)
    assert.ok(titleLines.every((line) => line.top + line.lineHeight <= author.top + 1))
  })
})

describe('layoutCard: quarters path', () => {
  test('seven covers: four quarters, two halves and the winner on top', () => {
    const ops = covers(layoutCard(treeSpec(), ruler))
    assert.equal(ops.length, 7)
    const top = ops.reduce((a, b) => (a.y < b.y ? a : b))
    assert.equal(top.w, Math.max(...ops.map((c) => c.w)))
    assert.equal(top.x + top.w / 2, 540)
    // Quarter picks all share one row, level with each other.
    const bottomRow = ops.filter((c) => c.y === Math.max(...ops.map((o) => o.y)))
    assert.equal(bottomRow.length, 4)
  })

  test('six hairlines join them: each quarter to its half, each half to the winner', () => {
    assert.equal(lines(layoutCard(treeSpec(), ruler)).length, 6)
  })

  test('a quarter nobody read in is left out, with its line', () => {
    const missing = [QUARTERS[0]!, null, QUARTERS[2]!, QUARTERS[3]!]
    const ops = layoutCard(treeSpec({ quarters: missing }), ruler)
    assert.equal(covers(ops).length, 6)
    assert.equal(lines(ops).length, 5)
  })

  test('the quarter names sit under the bottom row', () => {
    const ops = layoutCard(treeSpec(), ruler)
    const bottomEdge = Math.max(...covers(ops).map((c) => c.y + c.h))
    const names = texts(ops).filter((t) => /^Q\d$/.test(t.text))
    assert.equal(names.length, 4)
    assert.ok(names.every((n) => n.top >= bottomEdge))
  })

  test('small covers carry no title; big ones do', () => {
    const ops = layoutCard(treeSpec({ shape: 'story' }), ruler)
    const inside = texts(ops).filter((t) => t.font.family === 'serif' && t.font.weight === 500)
    // Half and winner covers are wide enough for a title; none is drawn twice.
    assert.ok(inside.length >= 3)
  })
})

describe('layoutCard: full path', () => {
  test('nineteen covers (12 + 4 + 2 + the winner) and eighteen hairlines', () => {
    for (const shape of SHAPES) {
      const ops = layoutCard(fullSpec({ shape }), ruler)
      assert.equal(covers(ops).length, 19, shape)
      assert.equal(lines(ops).length, 18, shape)
    }
  })

  test('a month nobody read in is left out with its line; a whole empty quarter takes its months with it', () => {
    const one = MONTH_BOOKS.map((b, i) => (i === 4 ? null : b))
    const ops = layoutCard(fullSpec({ months: one }), ruler)
    assert.equal(covers(ops).length, 18)
    assert.equal(lines(ops).length, 17)

    const noQ2 = MONTH_BOOKS.map((b, i) => (i >= 3 && i <= 5 ? null : b))
    const gap = layoutCard(fullSpec({ months: noQ2, quarters: [QUARTERS[0]!, null, QUARTERS[2]!, QUARTERS[3]!] }), ruler)
    assert.equal(covers(gap).length, 15)
    assert.equal(lines(gap).length, 14)
  })

  test('the winner is on top, widest, and each month sits under its own quarter', () => {
    const ops = layoutCard(fullSpec({ shape: 'story' }), ruler)
    const all = covers(ops)
    const winner = all.find((c) => c.y === Math.min(...all.map((x) => x.y)))!
    assert.ok(all.every((c) => c.w <= winner.w))
    const months = all.filter((c) => c.w === 60).sort((a, b) => a.x - b.x)
    const quarters = all.filter((c) => c.w === 140).sort((a, b) => a.x - b.x)
    assert.equal(months.length, 12)
    assert.equal(quarters.length, 4)
    months.forEach((m, i) => {
      const q = quarters[Math.floor(i / 3)]!
      assert.ok(Math.abs(m.x + m.w / 2 - (q.x + q.w / 2)) < 140, `month ${i + 1} is far from its quarter`)
    })
  })

  test('the month letters sit under the bottom row', () => {
    const ops = layoutCard(fullSpec(), ruler)
    const bottomEdge = Math.max(...covers(ops).map((c) => c.y + c.h))
    const letters = texts(ops).filter((t) => t.text.length === 1)
    assert.equal(letters.length, 12)
    assert.ok(letters.every((l) => l.top >= bottomEdge))
  })
})

describe('layoutCard: top 5 and top 10', () => {
  test('winner plus four rows, or plus nine: one cover and one hairline per row', () => {
    for (const shape of SHAPES) {
      const five = layoutCard(tiersSpec('top5', { shape }), ruler)
      assert.equal(covers(five).length, 5, shape)
      assert.equal(lines(five).length, 4, shape)
      const ten = layoutCard(tiersSpec('top10', { shape }), ruler)
      assert.equal(covers(ten).length, 10, shape)
      assert.equal(lines(ten).length, 9, shape)
    }
  })

  test('fewer books than rows means fewer rows, not empty ones', () => {
    const ops = layoutCard(tiersSpec('top10', { placings: PLACINGS.slice(0, 2) }), ruler)
    assert.equal(covers(ops).length, 3)
    assert.equal(lines(ops).length, 2)
    assert.equal(covers(layoutCard(tiersSpec('top5', { placings: [] }), ruler)).length, 1)
  })

  test('rows go down the picture in the order given, each with its tier label under the title', () => {
    for (const shape of SHAPES) {
      const ops = layoutCard(tiersSpec('top10', { shape }), ruler)
      const rows = covers(ops).filter((c) => !ops.some((o) => o.kind === 'frame' && o.x < c.x && o.x + o.w > c.x + c.w)).sort((a, b) => a.y - b.y)
      assert.equal(rows.length, 9)
      const labels = texts(ops).filter((t) => PLACINGS.some((r) => r.label === t.text && t.font.family === 'sans'))
      assert.deepEqual(labels.sort((a, b) => a.top - b.top).map((t) => t.text), PLACINGS.map((r) => r.label), shape)
      rows.forEach((r, i) => i > 0 && assert.ok(r.y >= rows[i - 1]!.y + rows[i - 1]!.h, `${shape}: rows overlap`))
    }
  })

  test('the last row ends above the brand line', () => {
    for (const shape of SHAPES) {
      const ops = layoutCard(tiersSpec('top10', { shape }), ruler)
      const brand = texts(ops).find((t) => t.text === 'Loose Ends')!
      const lastBottom = Math.max(...covers(ops).map((c) => c.y + c.h))
      assert.ok(lastBottom < brand.top, `${shape}: ${lastBottom} vs ${brand.top}`)
    }
  })

  test('no rank numbers are drawn: tiers, not a ranking', () => {
    const ops = layoutCard(tiersSpec('top10'), ruler)
    assert.ok(!texts(ops).some((t) => /^\d+\.?$|^#\d+$|^No\. ?\d+$/.test(t.text)))
  })
})
