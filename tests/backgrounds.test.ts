import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseBackgrounds } from '../src/backgrounds.ts'

describe('parseBackgrounds', () => {
  test('reads good entries, with and without a photographer', () => {
    const list = parseBackgrounds({
      backgrounds: [
        { id: 'library', file: 'backgrounds/library.jpg', dark: true, photographer: ' Enrico Bet ' },
        { id: 'clouds', file: 'backgrounds/clouds.svg', dark: false },
      ],
    })
    assert.deepEqual(list, [
      { id: 'library', file: 'backgrounds/library.jpg', dark: true, photographer: 'Enrico Bet' },
      { id: 'clouds', file: 'backgrounds/clouds.svg', dark: false },
    ])
  })

  test('anything that is not a manifest means no backgrounds', () => {
    for (const bad of [null, undefined, 3, 'x', [], {}, { backgrounds: 'x' }, { backgrounds: {} }]) {
      assert.deepEqual(parseBackgrounds(bad), [])
    }
  })

  test('bad entries are skipped, the good ones kept', () => {
    const list = parseBackgrounds({
      backgrounds: [
        null,
        'x',
        { id: '', file: 'backgrounds/a.jpg' },
        { id: 'b' },
        { id: 'c', file: 'backgrounds/c.jpg', dark: 'yes' },
        { id: 'c', file: 'backgrounds/other.jpg' },
      ],
    })
    assert.deepEqual(list, [{ id: 'c', file: 'backgrounds/c.jpg', dark: false }])
  })

  test('a file outside backgrounds/ is refused, whatever it looks like', () => {
    for (const file of [
      '../secret.jpg',
      'backgrounds/../secret.jpg',
      '/backgrounds/a.jpg',
      'https://example.com/a.jpg',
      'backgrounds/sub/a.jpg',
      'backgrounds/a.html',
      'backgrounds/a.js',
      'other/a.jpg',
    ]) {
      assert.deepEqual(parseBackgrounds({ backgrounds: [{ id: 'x', file }] }), [], file)
    }
  })

  test('the real manifest is valid: every entry kept, every file exists, credits are real names', () => {
    const raw = JSON.parse(readFileSync('public/backgrounds.json', 'utf8')) as { backgrounds: unknown[] }
    const list = parseBackgrounds(raw)
    assert.equal(list.length, raw.backgrounds.length, 'an entry was dropped as invalid')
    for (const background of list) {
      assert.doesNotThrow(() => readFileSync(`public/${background.file}`), background.file)
      if (background.photographer) assert.ok(background.photographer.length > 2)
    }
  })
})
