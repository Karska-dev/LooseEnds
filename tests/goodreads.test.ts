import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseGoodreadsCsv } from '../src/goodreads.ts'

const HEAD = 'Title,Author,Exclusive Shelf,My Rating,Year Published,Original Publication Year'

describe('publication year', () => {
  it('prefers the original year over the edition year', () => {
    const { books } = parseGoodreadsCsv(`${HEAD}\nA Wizard of Earthsea,Ursula K. Le Guin,read,5,2012,1968\n`)
    assert.equal(books[0].year, 1968)
  })

  it('falls back to the edition year when the original is blank', () => {
    const { books } = parseGoodreadsCsv(`${HEAD}\nTehanu,Ursula K. Le Guin,to-read,0,1990,\n`)
    assert.equal(books[0].year, 1990)
  })

  it('is null when neither column holds a year', () => {
    const { books } = parseGoodreadsCsv(`${HEAD}\nUntitled,Someone,to-read,0, ,\n`)
    assert.equal(books[0].year, null)
  })
})
