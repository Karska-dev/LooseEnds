import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { shareText } from '../src/shareText.ts'
import { en } from '../src/i18n/en.ts'
import { uk } from '../src/i18n/uk.ts'

describe('shareText', () => {
  test('a caption alone when there is no photograph', () => {
    assert.equal(shareText('My book.'), 'My book.')
    assert.equal(shareText('My book.', undefined), 'My book.')
    assert.equal(shareText('My book.', '  '), 'My book.')
  })

  test('the credit goes under the caption, after a blank line', () => {
    assert.equal(shareText('My book.', 'Photo by A on Unsplash'), 'My book.\n\nPhoto by A on Unsplash')
  })

  test('stray spaces are trimmed', () => {
    assert.equal(shareText('  My book.  ', ' Photo by A '), 'My book.\n\nPhoto by A')
  })

  test('the real captions, in both languages, with and without an author', () => {
    assert.equal(en.yearBook.card.caption('Ember Crown', 'Lena Park', 2026), 'My favourite book of 2026: Ember Crown by Lena Park.')
    assert.equal(en.yearBook.card.caption('Ember Crown', '', 2026), 'My favourite book of 2026: Ember Crown.')
    assert.equal(uk.yearBook.card.caption('Ember Crown', 'Лена Парк', 2026), 'Моя улюблена книга 2026 року: «Ember Crown», Лена Парк.')
    assert.equal(uk.yearBook.card.caption('Ember Crown', '', 2026), 'Моя улюблена книга 2026 року: «Ember Crown».')
    assert.equal(
      shareText(en.yearBook.card.caption('X', 'Y', 2026), en.yearBook.card.credit('Enrico Bet')),
      'My favourite book of 2026: X by Y.\n\nPhoto by Enrico Bet on Unsplash',
    )
    assert.equal(uk.yearBook.card.credit('Enrico Bet'), 'Фото: Enrico Bet, Unsplash')
  })
})
