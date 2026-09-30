import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_FAVOURITES,
  NO_CHOICES,
  addFavourite,
  asideKeys,
  bringBack,
  hasChoices,
  isFull,
  parseChoices,
  presentFavourites,
  removeFavourite,
  serializeChoices,
  setAside,
} from '../src/choices.ts'
import type { Choices } from '../src/choices.ts'

const lib = (...keys: string[]) => new Set(keys)
const ALL = lib('a', 'b', 'c', 'd', 'e', 'f', 'g')

function hearted(...keys: string[]): Choices {
  return keys.reduce((c, k) => addFavourite(c, k, ALL), NO_CHOICES)
}

describe('parseChoices', () => {
  test('nothing, bad JSON and bad shapes are no choices', () => {
    assert.deepEqual(parseChoices(null), NO_CHOICES)
    assert.deepEqual(parseChoices('{nope'), NO_CHOICES)
    assert.deepEqual(parseChoices('42'), NO_CHOICES)
    assert.deepEqual(parseChoices('{"favourites":"a"}'), NO_CHOICES)
  })

  test('round-trips, dropping junk entries and duplicates', () => {
    const raw = '{"v":1,"favourites":["a",3,"a",""],"aside":["b"],"back":["c",null]}'
    assert.deepEqual(parseChoices(raw), { favourites: ['a'], aside: ['b'], back: ['c'] })
    const c = hearted('a', 'b')
    assert.deepEqual(parseChoices(serializeChoices(c)), c)
  })

  test('never more than five favourites, even hand-edited', () => {
    const raw = JSON.stringify({ favourites: ['a', 'b', 'c', 'd', 'e', 'f'] })
    assert.equal(parseChoices(raw).favourites.length, MAX_FAVOURITES)
  })
})

describe('favourites', () => {
  test('a sixth heart is refused while five are showing', () => {
    const five = hearted('a', 'b', 'c', 'd', 'e')
    assert.equal(isFull(five, ALL), true)
    assert.equal(addFavourite(five, 'f', ALL), five)
  })

  test('only favourites in the open library count', () => {
    const five = hearted('a', 'b', 'c', 'd', 'e')
    const otherExport = lib('a', 'b', 'f', 'g')
    assert.deepEqual(presentFavourites(five, otherExport), ['a', 'b'])
    assert.equal(isFull(five, otherExport), false)
  })

  test('untouched, absent favourites are kept for when that export comes back', () => {
    const five = hearted('a', 'b', 'c', 'd', 'e')
    const afterAside = setAside(five, 'g', lib('a', 'g'))
    assert.deepEqual(afterAside.favourites, five.favourites)
  })

  test('changing a heart saves only what you see — the total can never pass five', () => {
    const five = hearted('a', 'b', 'c', 'd', 'e')
    const otherExport = lib('a', 'b', 'f', 'g')
    const changed = addFavourite(five, 'f', otherExport)
    assert.deepEqual(changed.favourites, ['a', 'b', 'f'])
    // The first export comes back: c, d, e are gone, not a surprise sixth.
    assert.deepEqual(presentFavourites(changed, ALL), ['a', 'b', 'f'])
  })

  test('removing a heart', () => {
    const c = removeFavourite(hearted('a', 'b'), 'a', ALL)
    assert.deepEqual(c.favourites, ['b'])
    assert.equal(removeFavourite(c, 'z', ALL), c)
  })
})

describe('favourite and set aside exclude each other', () => {
  test('setting a favourite aside takes its heart away', () => {
    const c = setAside(hearted('a', 'b'), 'a', ALL)
    assert.deepEqual(c.favourites, ['b'])
    assert.deepEqual([...asideKeys(c, lib())], ['a'])
  })

  test('hearting a set-aside series brings it back', () => {
    const c = addFavourite(setAside(NO_CHOICES, 'a', ALL), 'a', ALL)
    assert.deepEqual(c.aside, [])
    assert.equal(asideKeys(c, lib()).has('a'), false)
  })

  test('a favourite is never set aside, even by the lookup', () => {
    const c = hearted('a')
    assert.equal(asideKeys(c, lib('a')).has('a'), false)
  })

  test('removing a heart from an abandoned series does not bury it again', () => {
    const c = removeFavourite(hearted('a'), 'a', ALL)
    assert.equal(asideKeys(c, lib('a')).has('a'), false)
  })
})

describe('asideKeys', () => {
  test('the lookup suggests, the reader decides', () => {
    const auto = lib('dnf1', 'dnf2')
    let c = bringBack(NO_CHOICES, 'dnf1')
    c = setAside(c, 'x', ALL)
    assert.deepEqual([...asideKeys(c, auto)].sort(), ['dnf2', 'x'])
  })

  test('set aside, then brought back, then set aside again', () => {
    let c = setAside(NO_CHOICES, 'a', ALL)
    c = bringBack(c, 'a')
    assert.equal(asideKeys(c, lib()).has('a'), false)
    c = setAside(c, 'a', ALL)
    assert.equal(asideKeys(c, lib('a')).has('a'), true)
  })
})

test('hasChoices', () => {
  assert.equal(hasChoices(NO_CHOICES), false)
  assert.equal(hasChoices(bringBack(NO_CHOICES, 'a')), true)
})
