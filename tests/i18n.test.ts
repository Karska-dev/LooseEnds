import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { dayMonth, dayMonthYear, monthYear } from '../src/dates.ts'
import { en } from '../src/i18n/en.ts'
import { CATALOGUES, LANGUAGES, pickLanguage } from '../src/i18n/index.ts'
import { uk } from '../src/i18n/uk.ts'
import { brief } from '../src/lookupWords.ts'
import { buildSeriesState } from '../src/state.ts'
import { PAST, TODAY, groupOf, resolved, volume } from './helpers.ts'

describe('which language the page opens in', () => {
  test('a choice made with the switch wins over the browser', () => {
    assert.equal(pickLanguage('uk', ['en-US', 'en']), 'uk')
    assert.equal(pickLanguage('en', ['uk-UA', 'uk']), 'en')
  })

  test('with no choice, the first language the page has decides', () => {
    assert.equal(pickLanguage(null, ['uk-UA', 'uk', 'en-US']), 'uk')
    assert.equal(pickLanguage(null, ['en-GB', 'uk']), 'en')
    // Polish first, then Ukrainian: the page has no Polish, so Ukrainian.
    assert.equal(pickLanguage(null, ['pl-PL', 'uk', 'en']), 'uk')
  })

  test('the region and the letter case of a tag do not matter', () => {
    assert.equal(pickLanguage(null, ['UK-ua']), 'uk')
    assert.equal(pickLanguage(null, ['en-AU']), 'en')
  })

  test('anything else is English', () => {
    assert.equal(pickLanguage(null, []), 'en')
    assert.equal(pickLanguage(null, ['de-DE', 'fr']), 'en')
    // A stored value from some other version of the page is not trusted.
    assert.equal(pickLanguage('klingon', ['uk']), 'uk')
    assert.equal(pickLanguage('', []), 'en')
  })

  test('the switch offers exactly the languages that have a catalogue', () => {
    assert.deepEqual(LANGUAGES.map((language) => language.id).sort(), Object.keys(CATALOGUES).sort())
  })
})

/**
 * The compiler already makes uk.ts match the shape of en.ts. These check what
 * a type cannot: that a list has as many items, and that a sentence with a
 * tag in it has the same tag in both languages.
 */
describe('the two catalogues line up', () => {
  type Tree = { [key: string]: unknown }
  const tagsOf = (text: string) => [...text.matchAll(/<(\w+)>/g)].map((match) => match[1]).sort()

  function compare(a: unknown, b: unknown, path: string) {
    assert.equal(typeof b, typeof a, `${path}: one is ${typeof a}, the other ${typeof b}`)
    if (typeof a === 'string' && typeof b === 'string') {
      assert.ok(b.trim().length > 0, `${path} is empty in Ukrainian`)
      assert.deepEqual(tagsOf(b), tagsOf(a), `${path}: different tags`)
    } else if (Array.isArray(a) && Array.isArray(b)) {
      assert.equal(b.length, a.length, `${path}: different number of items`)
      a.forEach((item, index) => compare(item, b[index], `${path}[${index}]`))
    } else if (typeof a === 'object' && a !== null) {
      assert.deepEqual(Object.keys(b as Tree).sort(), Object.keys(a).sort(), `${path}: different keys`)
      for (const key of Object.keys(a)) compare((a as Tree)[key], (b as Tree)[key], `${path}.${key}`)
    }
  }

  test('same keys, same list lengths, same tags', () => {
    compare(en, uk, 'messages')
  })

  test('twelve months each', () => {
    assert.equal(en.months.length, 12)
    assert.equal(uk.months.length, 12)
  })
})

describe('Ukrainian counts', () => {
  test('a noun after a number takes one of three forms', () => {
    const said = [1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111].map((n) => uk.shelf.books(n))
    assert.deepEqual(said, [
      '1 книга',
      '2 книги',
      '4 книги',
      '5 книг',
      // 11–14 look like "one" and "few" by their last digit, and are neither.
      '11 книг',
      '12 книг',
      '14 книг',
      '21 книга',
      '22 книги',
      '25 книг',
      '101 книга',
      '111 книг',
    ])
  })

  test('the board says how many series it shows', () => {
    assert.equal(uk.tiles.showing(1), 'Показано 1 серію')
    assert.equal(uk.tiles.showing(3), 'Показано 3 серії')
    assert.equal(uk.tiles.showing(6), 'Показано 6 серій')
    assert.equal(uk.tiles.aria('Дочитані', 1, false), 'Дочитані, 1 серія, приховано зі списку')
    assert.equal(uk.tiles.hidden(['Дочитані', 'Відкладені']), 'Дочитані та відкладені приховано')
  })

  test('a whole position takes an ending, a side story cannot', () => {
    assert.equal(uk.verdict.youAreOn(2), 'ви на 2-й')
    assert.equal(uk.verdict.youAreOn(2.5), 'ви на книзі 2.5')
  })
})

describe('the lookup summary', () => {
  const names = { reading: ['Dune'], waiting: ['Foundation'], complete: ['Discworld'] }

  test('in English it reads as before', () => {
    assert.equal(en.lookup.afterTitle(4), 'Four series have a next book waiting')
    assert.equal(en.lookup.afterTitle(1), 'One series has a next book waiting')
    assert.equal(en.lookup.afterTitle(0), 'You’re all caught up')
    assert.equal(
      en.lookup.afterBody(names),
      'You’re partway through Dune, Foundation is waiting on its author and you’ve finished Discworld.',
    )
    assert.equal(en.lookup.afterBody({ reading: [], waiting: [], complete: [] }), null)
  })

  test('in Ukrainian the number word agrees and titles stay as they are', () => {
    assert.equal(uk.lookup.afterTitle(1), 'В одній серії на вас чекає наступна книга')
    assert.equal(uk.lookup.afterTitle(4), 'У чотирьох серіях на вас чекає наступна книга')
    // Past ten there is no word for it, and a digit needs no ending.
    assert.equal(uk.lookup.afterTitle(12), 'У 12 серіях на вас чекає наступна книга')
    assert.equal(
      uk.lookup.afterBody(names),
      'Ви читаєте «Dune», «Foundation» чекає на автора, а «Discworld» ви вже дочитали.',
    )
    assert.equal(
      uk.lookup.afterBody({ reading: ['A', 'B'], waiting: ['C', 'D', 'E', 'F', 'G'], complete: [] }),
      'Ви читаєте дві серії, а п’ять серій чекають на авторів.',
    )
  })

  test('a failure names what is left, and counts the seconds', () => {
    assert.equal(
      en.lookup.failedBody(2, 5, ['A', 'B', 'C'], 30),
      'We heard back about 2 of your 5 series. A, B and C can try again in 30 seconds.',
    )
    assert.equal(
      uk.lookup.failedBody(2, 5, ['A', 'B', 'C', 'D', 'E'], 21),
      'Є відповідь про 2 із 5 ваших серій. Залишилося: «A», «B», «C» та ще 2. Спробувати ще раз можна за 21 секунду.',
    )
    assert.equal(
      uk.lookup.failedBody(0, 1, ['A'], null),
      'Про вашу серію відповіді немає. Спробуйте ще раз — зазвичай це тимчасово.',
    )
  })
})

describe('dates', () => {
  test('are written with the month names of the language', () => {
    assert.equal(monthYear('2023-04-11', en.months), 'Apr 2023')
    assert.equal(monthYear('2023-04-11', uk.months), 'квіт. 2023')
    assert.equal(dayMonth('2026-10-14', en.months), '14 Oct')
    assert.equal(dayMonth('2026-10-14', uk.months), '14 жовт.')
    assert.equal(dayMonthYear('2027-03-02', en.months), '2 Mar 2027')
    assert.equal(dayMonthYear('2027-03-02', uk.months), '2 бер. 2027')
  })

  test('a date with only a year stays a year', () => {
    assert.equal(monthYear('1984', uk.months), '1984')
    assert.equal(dayMonthYear('2027-03', uk.months), 'бер. 2027')
  })
})

describe('the one-line verdict while a lookup runs', () => {
  const three = [1, 2, 3].map((n) => volume(n, { releaseDate: PAST }))
  const state = buildSeriesState(groupOf([['read', 'One (Test Series, #1)']]), resolved(three, 3), TODAY)

  test('is worded by the language it is given', () => {
    const english = brief(state, en)
    const ukrainian = brief(state, uk)
    assert.equal(english.kind, 'go')
    assert.equal(ukrainian.kind, 'go')
    assert.equal(english.label, 'Next')
    assert.equal(ukrainian.label, 'Далі')
    assert.match(english.text, /^#2 /)
    assert.match(ukrainian.text, /^2 · /)
  })
})
