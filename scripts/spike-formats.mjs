#!/usr/bin/env node
/**
 * Spike for #5: does Hardcover already know when each FORMAT of a book comes
 * out — ebook, audiobook, print — and does it know it early enough to say
 * "ebook out, audiobook in March"?
 *
 *   node scripts/spike-formats.mjs                      # a built-in mix
 *   node scripts/spike-formats.mjs "Dungeon Crawler Carl" "The Expanse"
 *
 * For every position it prints the book's own date, then per format:
 *   default  — the book's default_{physical,ebook,audio}_edition (one hop,
 *              cheap: what the Worker would add to today's query)
 *   english  — earliest English edition of that format among ALL editions
 *              (the expensive, thorough answer)
 * and marks rows where the formats disagree by more than 30 days.
 *
 * It also tries the query shape the Worker uses today at depth 4, because
 * Hardcover plans a max query depth of 3 in 2026 and will reject it.
 *
 * Read-only. Uses HARDCOVER_TOKEN from the environment or .env.local. Costs
 * about 3 requests per series; paced at 1.1 s like the Worker.
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { bestHit } from '../src/shared/hardcover.ts'

const DEFAULT_SERIES = [
  ['Dungeon Crawler Carl', 'Matt Dinniman'], // audio-first
  ['He Who Fights with Monsters', 'Shirtaloon'], // audio-first, progression
  ['The Expanse', 'James S. A. Corey'],
  ['The Stormlight Archive', 'Brandon Sanderson'],
  ['The Empyrean', 'Rebecca Yarros'], // book 4 announced / dated
  ['The Murderbot Diaries', 'Martha Wells'],
]

const argv = process.argv.slice(2)
const series = argv.length ? argv.map((name) => [name, undefined]) : DEFAULT_SERIES

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
let last = 0
async function gql(query) {
  const wait = last + 1100 - Date.now()
  if (wait > 0) await sleep(wait)
  last = Date.now()
  const response = await fetch('https://api.hardcover.app/v1/graphql', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token.replace(/^Bearer\s+/i, '')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.errors?.length) {
    return { error: body.errors?.[0]?.message ?? `HTTP ${response.status}` }
  }
  return { data: body.data }
}

const FORMAT = { 1: 'print', 2: 'audio', 3: 'print', 4: 'ebook' }
const ED = 'release_date language_id reading_format_id edition_format asin isbn_13'
const pad = (v, w) => String(v ?? '—').slice(0, w).padEnd(w)
const days = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000)
const today = new Date().toISOString().slice(0, 10)
const mark = (d) => (!d ? '—' : d > today ? `${d}*` : d)

const report = []
const summary = { positions: 0, audioDefault: 0, audioEnglish: 0, ebookDefault: 0, split: 0, future: 0 }

for (const [name, author] of series) {
  const found = await gql(
    `query { search(query: ${JSON.stringify(name)}, query_type: "series", per_page: 15, page: 1) { results } }`,
  )
  if (found.error) {
    console.log(`\n${name}: search failed — ${found.error}`)
    continue
  }
  const hit = bestHit((found.data.search?.results?.hits ?? []).map((h) => h.document), name, author)
  if (!hit) {
    console.log(`\n${name}: no match`)
    continue
  }

  const deep = await gql(
    `query { series_by_pk(id: ${hit.id}) { name book_series(order_by: {position: asc}, where: {position: {_is_null: false}}) { position book { id title release_date users_read_count default_physical_edition { ${ED} } default_ebook_edition { ${ED} } default_audio_edition { ${ED} } } } } }`,
  )
  if (deep.error) {
    console.log(`\n${hit.name}: depth-4 query (today's shape) FAILED — ${deep.error}`)
    continue
  }
  // Translations and box sets share the original's position. Keep one book
  // per whole-number position: the most-read, which is the original.
  const best = new Map()
  for (const r of deep.data.series_by_pk?.book_series ?? []) {
    if (!r.book || !Number.isInteger(r.position)) continue
    const held = best.get(r.position)
    if (!held || (r.book.users_read_count ?? 0) > (held.book.users_read_count ?? 0)) best.set(r.position, r)
  }
  const rows = [...best.values()].sort((a, b) => a.position - b.position)
  const ids = rows.map((r) => r.book.id)
  const per = { name: hit.name, positions: 0, audio: 0, ebook: 0, print: 0, split: 0, future: [] }
  report.push(per)

  // The flat alternative: depth 1, every English edition of these books.
  const flat = await gql(
    `query { editions(where: {book_id: {_in: [${ids.join(',')}]}, language_id: {_eq: 1}}, order_by: {release_date: asc_nulls_last}, limit: 2000) { book_id ${ED} } }`,
  )
  const earliest = new Map() // book_id -> { print, ebook, audio }
  if (flat.error) console.log(`  (flat editions query failed — ${flat.error})`)
  for (const e of flat.data?.editions ?? []) {
    const f = FORMAT[e.reading_format_id]
    if (!f || !e.release_date) continue
    const slot = earliest.get(e.book_id) ?? {}
    if (!slot[f] || e.release_date < slot[f]) slot[f] = e.release_date
    earliest.set(e.book_id, slot)
  }

  console.log(`\n${hit.name}  (${ids.length} books, ${flat.data?.editions?.length ?? '?'} English editions)`)
  console.log(
    `  ${pad('#', 5)}${pad('title', 30)}${pad('book', 12)}` +
      `${pad('print def/eng', 24)}${pad('ebook def/eng', 24)}${pad('audio def/eng', 24)}`,
  )
  for (const { position, book } of rows) {
    if (!Number.isInteger(position)) continue
    const eng = earliest.get(book.id) ?? {}
    const d = {
      print: book.default_physical_edition,
      ebook: book.default_ebook_edition,
      audio: book.default_audio_edition,
    }
    const cell = (f) => {
      const ed = d[f]
      const lang = ed && ed.language_id !== 1 ? `(l${ed.language_id})` : ''
      return pad(`${mark(ed?.release_date)}${lang} / ${mark(eng[f])}`, 24)
    }
    const dates = ['print', 'ebook', 'audio'].map((f) => eng[f] ?? (d[f]?.language_id === 1 ? d[f].release_date : null)).filter(Boolean)
    const spread = dates.length > 1 ? days(dates.sort().at(-1), dates[0]) : 0
    summary.positions += 1
    per.positions += 1
    if (eng.audio || (d.audio?.language_id === 1 && d.audio?.release_date)) per.audio += 1
    if (eng.ebook || (d.ebook?.language_id === 1 && d.ebook?.release_date)) per.ebook += 1
    if (eng.print || (d.print?.language_id === 1 && d.print?.release_date)) per.print += 1
    if (spread > 30) per.split += 1
    if ((book.release_date ?? '') > today || ['print', 'ebook', 'audio'].some((f) => (eng[f] ?? '') > today)) {
      per.future.push({ position, title: book.title, book: book.release_date, default: { print: d.print?.release_date ?? null, ebook: d.ebook?.release_date ?? null, audio: d.audio?.release_date ?? null }, english: eng })
    }
    if (d.audio?.release_date) summary.audioDefault += 1
    if (eng.audio) summary.audioEnglish += 1
    if (d.ebook?.release_date) summary.ebookDefault += 1
    if (spread > 30) summary.split += 1
    if ((book.release_date ?? '') > today) summary.future += 1
    console.log(
      `  ${pad(position, 5)}${pad(book.title, 30)}${pad(mark(book.release_date), 12)}` +
        `${cell('print')}${cell('ebook')}${cell('audio')}${spread > 30 ? `  ← formats ${spread} days apart` : ''}`,
    )
  }
}

console.log(`\n* = in the future (after ${today}); lNN = default edition not in English`)
console.log(
  `Main-line positions: ${summary.positions}. With an audio date: ${summary.audioDefault} via the default edition, ` +
    `${summary.audioEnglish} via all English editions. With an ebook date (default): ${summary.ebookDefault}. ` +
    `Formats more than 30 days apart: ${summary.split}. Book not out yet: ${summary.future}.`,
)

// A short version to read back, beside the long table above.
const lines = ['series | positions | with audio date | ebook | print | formats >30d apart']
for (const r of report) lines.push(`${r.name} | ${r.positions} | ${r.audio} | ${r.ebook} | ${r.print} | ${r.split}`)
lines.push('', 'Not out yet in at least one format:')
for (const r of report) for (const f of r.future) lines.push(`${r.name} #${f.position} ${f.title}: book ${f.book ?? '—'} · default ${JSON.stringify(f.default)} · english ${JSON.stringify(f.english)}`)
writeFileSync('spike-formats.txt', lines.join('\n') + '\n')
console.log('\nShort version written to spike-formats.txt')
