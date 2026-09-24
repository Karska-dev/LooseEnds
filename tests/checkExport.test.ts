import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseGoodreadsCsv } from '../src/goodreads.ts'
import { checkParsed, leftOutNote, sniffExport } from '../src/checkExport.ts'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url))
const bytes = (name: string) => new Uint8Array(fixture(name))
const parse = (name: string) => parseGoodreadsCsv(fixture(name).toString('utf8'))

describe('sniffExport — refused before the whole file is read', () => {
  it('an empty file', () => {
    assert.deepEqual(sniffExport(bytes('bad-empty.csv')), { kind: 'empty' })
  })

  it('a saved web page', () => {
    const problem = sniffExport(bytes('bad-not-a-csv.csv'))
    assert.equal(problem?.kind, 'html')
  })

  it('a CSV that is not a Goodreads export, naming what is missing', () => {
    const problem = sniffExport(bytes('bad-wrong-columns.csv'))
    assert.equal(problem?.kind, 'columns')
    if (problem?.kind === 'columns') {
      assert.deepEqual(problem.missing, ['Title', 'Author', 'Exclusive Shelf'])
      assert.ok(problem.found.includes('title'))
    }
  })

  it('a spreadsheet saved from Excel or Numbers', () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])
    assert.deepEqual(sniffExport(zip), { kind: 'binary', what: 'spreadsheet' })
  })

  it('a PDF', () => {
    assert.deepEqual(sniffExport(new TextEncoder().encode('%PDF-1.7\n')), { kind: 'binary', what: 'pdf' })
  })

  it('lets a real export through, BOM and all', () => {
    assert.equal(sniffExport(bytes('sample.csv')), null)
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('sample.csv')])
    assert.equal(sniffExport(withBom), null)
  })
})

describe('checkParsed — what the full read finds', () => {
  it('right columns, no books', () => {
    assert.deepEqual(checkParsed(parse('bad-header-only.csv')), { kind: 'no-books' })
  })

  it('an unclosed quote refuses the file and says where', () => {
    const problem = checkParsed(parse('bad-malformed.csv'))
    assert.equal(problem?.kind, 'damaged')
    if (problem?.kind === 'damaged') {
      assert.equal(problem.line, 2)
      assert.match(problem.text, /Unclosed quote/)
    }
  })

  it('odd but readable rows still load, with a note on what was left out', () => {
    const result = parse('bad-edge-cases.csv')
    assert.equal(checkParsed(result), null)
    assert.equal(leftOutNote(result), '2 rows left out: 2 with no title.')
  })

  it('ratings outside 1–5 are treated as no rating', () => {
    const books = parse('bad-edge-cases.csv').books
    const ratingOf = (author: string) => books.find((book) => book.author === author)?.rating
    assert.equal(ratingOf('Rating Test'), null)
  })

  it('a clean export has nothing to report', () => {
    const result = parse('classics.csv')
    assert.equal(checkParsed(result), null)
    assert.equal(leftOutNote(result), null)
  })
})
