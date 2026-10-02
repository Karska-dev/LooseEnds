#!/usr/bin/env node
/**
 * Proves the flat series fetch returns exactly what the nested one did.
 *
 *   node scripts/compare-flat.mjs                       # a built-in mix
 *   node scripts/compare-flat.mjs "Mistborn" "Dune"     # your own
 *
 * For each series it resolves the name with the real resolver (the flat
 * queries in src/shared/hardcover.ts), then asks Hardcover the old way —
 * series → book_series → book → default editions, depth 4 — and compares
 * the volumes field by field. Once Hardcover enforces its depth limit the
 * old query will be refused; the script says so and stops comparing.
 *
 * Read-only. Uses HARDCOVER_TOKEN from the environment or .env.local. About
 * 4 requests per series, paced like the Worker. These requests are NOT
 * counted in the Worker's daily budget.
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { editionsByPosition, resolveSeriesNames } from '../src/shared/hardcover.ts'

const DEFAULTS = [
  ['The Stormlight Archive', 'Brandon Sanderson'], // many translations per position
  ['Discworld', 'Terry Pratchett'], // long
  ['The Expanse', 'James S. A. Corey'],
  ['Dungeon Crawler Carl', 'Matt Dinniman'],
  ['The Murderbot Diaries', 'Martha Wells'], // novellas at .5 positions
  ['Earthsea Cycle', 'Ursula K. Le Guin'],
  ['The Rules of Scoundrels', 'Sarah MacLean'],
  ['The Split Worlds', 'Emma Newman'], // no audiobooks
]

const argv = process.argv.slice(2)
const wanted = argv.length ? argv.map((name) => ({ name })) : DEFAULTS.map(([name, author]) => ({ name, author }))

const token = (() => {
  if (process.env.HARDCOVER_TOKEN) return process.env.HARDCOVER_TOKEN
  if (!existsSync('.env.local')) return null
  const match = readFileSync('.env.local', 'utf8').match(/^\s*HARDCOVER_TOKEN\s*=\s*(.*)$/m)
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : null
})()
if (!token) {
  console.error('No HARDCOVER_TOKEN in the environment or .env.local.')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const NESTED = (id) =>
  `query { series_by_pk(id: ${id}) { name primary_books_count book_series(order_by: {position: asc}) { position book { id title slug release_date users_read_count image { url color } default_ebook_edition { language_id } default_physical_edition { language_id } default_audio_edition { language_id release_date } } } } }`

async function nested(id) {
  await sleep(1100)
  const response = await fetch('https://api.hardcover.app/v1/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${token.replace(/^Bearer\s+/i, '')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: NESTED(id) }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.errors?.length) return { error: body.errors?.[0]?.message ?? `HTTP ${response.status}` }
  return { node: body.data?.series_by_pk ?? null }
}

console.log(`Resolving ${wanted.length} series with the flat queries…`)
const meter = { requests: 0 }
const started = Date.now()
const flat = await resolveSeriesNames(wanted, token, meter)
console.log(`  ${meter.requests} requests, ${Math.round((Date.now() - started) / 1000)}s\n`)

const lines = ['series | flat status | positions | editions | same as nested?']
let same = 0
let differ = 0
let skipped = 0

for (const result of flat) {
  const editions = result.volumes.reduce((n, v) => n + v.editions.length, 0)
  const head = `${result.matchedName ?? result.query} | ${result.status}${result.detail ? ` (${result.detail})` : ''} | ${result.volumes.length} | ${editions}`
  if (result.status === 'error' || result.hardcoverId === null) {
    lines.push(`${head} | — not compared`)
    skipped += 1
    continue
  }
  const old = await nested(result.hardcoverId)
  if (old.error) {
    lines.push(`${head} | nested query refused: ${old.error}`)
    skipped += 1
    continue
  }
  const expected = old.node ? editionsByPosition(old.node) : []
  const a = JSON.stringify(result.volumes)
  const b = JSON.stringify(expected)
  const totalsMatch = (old.node?.primary_books_count ?? null) === result.totalBooks && (old.node?.name ?? null) === result.matchedName
  if (a === b && totalsMatch) {
    same += 1
    lines.push(`${head} | SAME`)
    continue
  }
  differ += 1
  lines.push(`${head} | DIFFERENT (nested: ${expected.length} positions)`)
  const byPos = new Map(expected.map((v) => [v.position, v]))
  for (const volume of result.volumes) {
    const other = byPos.get(volume.position)
    byPos.delete(volume.position)
    if (!other) lines.push(`    position ${volume.position}: only in flat`)
    else if (JSON.stringify(other) !== JSON.stringify(volume)) {
      lines.push(`    position ${volume.position}: flat ${JSON.stringify(volume.editions.map((e) => [e.title, e.languageId, e.releaseDate, e.audioDate]))}`)
      lines.push(`    ${' '.repeat(String(volume.position).length + 10)}nested ${JSON.stringify(other.editions.map((e) => [e.title, e.languageId, e.releaseDate, e.audioDate]))}`)
    }
  }
  for (const position of byPos.keys()) lines.push(`    position ${position}: only in nested`)
  if (!totalsMatch) lines.push(`    name/total: flat ${result.matchedName}/${result.totalBooks}, nested ${old.node?.name}/${old.node?.primary_books_count}`)
}

lines.push('', `SAME: ${same}   DIFFERENT: ${differ}   not compared: ${skipped}   flat requests: ${meter.requests} for ${wanted.length} series`)
const text = lines.join('\n') + '\n'
console.log(text)
writeFileSync('compare-flat.txt', text)
console.log('Written to compare-flat.txt')
process.exit(differ > 0 ? 1 : 0)
