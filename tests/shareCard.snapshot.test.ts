import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { en } from '../src/i18n/en.ts'
import { uk } from '../src/i18n/uk.ts'
import { QUIET_DARK, QUIET_LIGHT, SIZES, layoutCard } from '../src/shareCard.ts'
import type { CardBook, CardSpec, Format, FontSpec, Op, Shape } from '../src/shareCard.ts'

/**
 * Snapshot tests for the share pictures: every language × shape × picture ×
 * look is laid out, and what comes out (the exact list of drawing steps) is
 * compared with a saved copy.
 *
 * Why the layout and not the pixels: a pixel comparison needs a browser in
 * the test run, and fonts draw a little differently on every machine, so it
 * fails for no reason. The layout is the part we write; the canvas only
 * replays it. If the list of steps is the same, the picture is the same.
 *
 * A snapshot test cannot say whether a change is good, only that something
 * changed. So a failure means: look at the pictures, and if the change was
 * meant, refresh the saved copy with `UPDATE_SNAPSHOTS=1 npm test` and
 * commit it with the change. Only a hash and the step counts are saved, to
 * keep the file small and the diffs readable.
 */

const FILE = 'tests/fixtures/shareCard.snapshot.json'
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1'

/** A fixed ruler, so a different machine or font cannot change the result. */
const ruler = (text: string, font: FontSpec) => [...text].length * font.size * 0.5

const SHAPES: Shape[] = ['story', 'post', 'square']
const FORMATS: Format[] = ['winner', 'quarters', 'full', 'top5', 'top10']
const LOOKS = ['plain', 'photo-light', 'photo-dark'] as const
type Look = (typeof LOOKS)[number]

type Catalogue = typeof en
const LANGUAGES: [string, Catalogue, string[]][] = [
  ['en', en, ['Ember Crown', 'Iron Engine', 'Marrow Orchard', 'Quiet Court', 'Glass Garden', 'Lantern Road', 'Cold Thaw', 'Marrow Season', 'Glass Crown', 'Wolfsong Road', 'The Long Thaw of the Small Gods of Lisbon', 'Kestrel Court']],
  ['uk', uk as Catalogue, ['Хроніки Нескінченного Саду', 'Залізний двигун', 'Сад кісткового мозку', 'Тихий двір', 'Скляний сад', 'Ліхтарна дорога', 'Холодне танення', 'Сезон мармуру', 'Скляна корона', 'Шлях вовчої пісні', 'Довга відлига малих богів Лісабона та сім дверей у нікуди', 'Двір боривітра']],
]

const book = (title: string, i: number): CardBook => ({ title, author: i === 0 ? 'Лена Парк' : 'Lena Park', tint: i % 5 })

/** The same words and numbers the page gives the canvas (see ShareCard in YearBookTab.tsx). */
function specFor(t: Catalogue, titles: string[], shape: Shape, format: Format, look: Look): CardSpec {
  const y = t.yearBook
  const books = titles.map(book)
  const months = books // January..December
  const quarters = [months[0]!, months[3]!, months[6]!, months[10]!]
  const halves = [quarters[0]!, quarters[2]!]
  const winner = halves[0]!
  const placings = [
    { book: books[3]!, label: y.card.runnerUp },
    { book: books[6]!, label: y.card.quarterPick(y.stage.quarter(2)) },
    { book: books[10]!, label: y.card.quarterPick(y.stage.quarter(3)) },
    ...[1, 2, 4, 5, 7].map((m) => ({ book: books[m]!, label: y.monthNames[m]! })),
  ]
  const count = 85
  const stat =
    format === 'quarters'
      ? y.card.quartersStat(4, 12, count)
      : format === 'full'
        ? y.card.fullStat(12, count)
        : y.card.stat(count, 2026)
  const photo = look === 'plain' ? undefined : { src: '/backgrounds/library.jpg', credit: y.card.credit('Enrico Bet') }
  return {
    format,
    shape,
    palette: look === 'photo-dark' ? QUIET_DARK : QUIET_LIGHT,
    background: photo,
    label: y.card.label(2026),
    stat,
    winner,
    quarters,
    halves,
    quarterNames: [0, 1, 2, 3].map((i) => y.stage.quarter(i)),
    months,
    monthLetters: t.months.map((m) => [...m][0]!.toLocaleUpperCase()),
    placings,
  }
}

/** Numbers rounded, so a floating-point wobble on another machine is not a change. */
const canonical = (ops: Op[]) => JSON.stringify(ops, (_, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v))

interface Entry {
  hash: string
  steps: number
  covers: number
  texts: number
}

function snapshotOf(ops: Op[]): Entry {
  return {
    hash: createHash('sha256').update(canonical(ops)).digest('hex').slice(0, 16),
    steps: ops.length,
    covers: ops.filter((op) => op.kind === 'cover').length,
    texts: ops.filter((op) => op.kind === 'text').length,
  }
}

const cases: [string, Entry][] = []
for (const [lang, t, titles] of LANGUAGES)
  for (const shape of SHAPES)
    for (const format of FORMATS)
      for (const look of LOOKS) {
        cases.push([`${lang}/${shape}/${format}/${look}`, snapshotOf(layoutCard(specFor(t, titles, shape, format, look), ruler))])
      }

const current = Object.fromEntries(cases)
if (UPDATE) writeFileSync(FILE, `${JSON.stringify(current, null, 1)}\n`)
const saved: Record<string, Entry> = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {}

describe('share picture snapshots', () => {
  for (const [lang] of LANGUAGES) {
    for (const shape of SHAPES) {
      test(`${lang} ${shape}: every picture and look is laid out as saved`, () => {
        const changed = cases
          .filter(([key]) => key.startsWith(`${lang}/${shape}/`))
          .filter(([key, entry]) => JSON.stringify(entry) !== JSON.stringify(saved[key]))
          .map(([key, entry]) => `${key}: now ${JSON.stringify(entry)}, saved ${JSON.stringify(saved[key])}`)
        assert.deepEqual(
          changed,
          [],
          'The layout changed. Look at the pictures; if the change is meant, run UPDATE_SNAPSHOTS=1 npm test and commit tests/fixtures/shareCard.snapshot.json.',
        )
      })
    }
  }

  test('the saved copy has exactly the cases there are: none missing, none left over', () => {
    assert.deepEqual(Object.keys(saved).sort(), Object.keys(current).sort())
  })

  test('the cases really differ from each other, so a snapshot cannot pass by being empty', () => {
    const hashes = new Set(cases.map(([, entry]) => entry.hash))
    assert.equal(hashes.size, cases.length)
    for (const [key, entry] of cases) assert.ok(entry.steps > 5 && entry.texts >= 3, key)
  })

  test('every picture is drawn for every size', () => {
    assert.equal(cases.length, LANGUAGES.length * Object.keys(SIZES).length * FORMATS.length * LOOKS.length)
  })
})
