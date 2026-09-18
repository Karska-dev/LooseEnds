#!/usr/bin/env node
/**
 * Shows why a series matched — or did not. Prints every hit Hardcover
 * returned, which survive each filter, and what finally won, then retries
 * with variations to show whether a different query would have found it.
 *
 *   node scripts/explain-match.mjs "Mistborn" --author "Brandon Sanderson"
 *   node scripts/explain-match.mjs "Foundation" --author "Isaac Asimov"
 *
 * Uses the real predicates from src/shared/hardcover.ts, so what it reports
 * is what the Worker actually does.
 */

import { readFileSync, existsSync } from 'node:fs'
import { bestHit, nameRelated } from '../src/shared/hardcover.ts'

const args = process.argv.slice(2)
const name = args.find((a) => !a.startsWith('--'))
const authorIndex = args.indexOf('--author')
const author = authorIndex >= 0 ? args[authorIndex + 1] : undefined

if (!name) {
  console.error('Usage: node scripts/explain-match.mjs "<series name>" [--author "<author>"]')
  process.exit(1)
}

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

/** What the Worker sends today. */
const PER_PAGE = 15

async function search(query, perPage) {
  const body = await fetch('https://api.hardcover.app/v1/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `query { search(query: ${JSON.stringify(query)}, query_type: "series", per_page: ${perPage}, page: 1) { results } }`,
    }),
  }).then((r) => r.json())

  if (body.errors?.length) throw new Error(body.errors[0].message)
  return (body.data?.search?.results?.hits ?? []).map((hit) => hit.document)
}

const pad = (value, width) => String(value ?? '').slice(0, width).padEnd(width)

function table(hits) {
  console.log(`  ${pad('#', 3)}${pad('name', 42)}${pad('author', 22)}${pad('books', 7)}readers`)
  hits.forEach((hit, index) => {
    console.log(
      `  ${pad(index + 1, 3)}${pad(hit.name, 42)}${pad(hit.author_name, 22)}` +
        `${pad(hit.primary_books_count ?? 0, 7)}${hit.readers_count ?? 0}`,
    )
  })
}

async function main() {
  console.log(`\nSearching Hardcover for: "${name}"${author ? `  by ${author}` : ''}\n`)

  const hits = await search(name, PER_PAGE)
  if (hits.length === 0) {
    console.log(`  Hardcover returned nothing for this query at all.`)
  } else {
    console.log(`Raw hits (${hits.length}, capped at per_page: ${PER_PAGE}):`)
    table(hits)
  }

  // Replay the same narrowing the Worker does, one stage at a time.
  console.log('\nFilters:')
  const withBooks = hits.filter((hit) => (hit.primary_books_count ?? 0) > 0)
  console.log(`  has any books      ${withBooks.length} of ${hits.length}`)

  const pool1 = withBooks.length > 0 ? withBooks : hits
  const byName = pool1.filter((hit) => nameRelated(hit.name, name))
  console.log(`  name is related    ${byName.length} of ${pool1.length}`)
  if (byName.length === 0 && pool1.length > 0) {
    console.log('    (none related — the filter is skipped, so popularity decides)')
  }

  const winner = bestHit(hits, name, author)
  console.log(`\nPicked: ${winner ? `"${winner.name}" by ${winner.author_name ?? '?'} ` +
    `(${winner.primary_books_count ?? 0} books, ${winner.readers_count ?? 0} readers)` : 'nothing'}`)

  if (winner && (winner.primary_books_count ?? 0) === 0) {
    console.log('  ⚠ zero books: this resolves to an empty volume list, which the app shows as unmatched.')
  }

  // Phase 2. A correct match still yields nothing if the volumes carry no
  // positions, and the app cannot tell that apart from "not found".
  if (winner && (winner.primary_books_count ?? 0) > 0) {
    await new Promise((r) => setTimeout(r, 1100))
    const detail = await fetch('https://api.hardcover.app/v1/graphql', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query { series_by_pk(id: ${Number(winner.id)}) { name primary_books_count book_series(order_by: {position: asc}) { position book { title release_date } } } }`,
      }),
    }).then((r) => r.json())

    const node = detail.data?.series_by_pk
    const entries = node?.book_series ?? []
    console.log(`\nVolumes on "${node?.name ?? winner.name}" (${entries.length} entries):`)

    if (entries.length === 0) {
      console.log('  none — the series record exists but has no books attached.')
    } else {
      for (const entry of entries) {
        const position = entry.position === null ? 'null' : String(entry.position)
        console.log(
          `  ${pad(position, 7)}${pad(entry.book?.title ?? '(no book)', 46)}` +
            `${entry.book?.release_date ?? ''}`,
        )
      }
      const usable = entries.filter((e) => e.position !== null && e.book)
      const mainLine = usable.filter(
        (e) => Number.isInteger(e.position) && e.position >= 1,
      )
      console.log(
        `\n  kept by the app: ${usable.length} of ${entries.length}` +
          ` (needs a position and a book), of which ${mainLine.length} are main-line`,
      )
      if (usable.length === 0) {
        console.log(
          '  ⚠ every entry is dropped, so the app sees an empty series and shows it as unmatched.',
        )
      } else if (mainLine.length === 0) {
        console.log(
          '  ⚠ no whole-numbered volumes, so there is never a "next book" to offer.',
        )
      }
    }
  }

  // Would a different query have found it?
  console.log('\nWould another query do better?')
  const variants = [
    ['deeper search (per_page 40)', name, 40],
    ['without a leading "The"', name.replace(/^the\s+/i, ''), PER_PAGE],
    ['with "The" prefixed', `The ${name}`, PER_PAGE],
    ...(author ? [[`with the author appended`, `${name} ${author}`, PER_PAGE]] : []),
  ]

  for (const [label, query, perPage] of variants) {
    if (query === name && perPage === PER_PAGE) continue
    await new Promise((r) => setTimeout(r, 1100))
    try {
      const alt = await search(query, perPage)
      const pick = bestHit(alt, name, author)
      const books = pick?.primary_books_count ?? 0
      const flag = pick && books > 0 && pick.name !== winner?.name ? '  ← different' : ''
      console.log(
        `  ${pad(label, 30)}${pick ? `"${pick.name}" (${books} books)` : 'nothing'}${flag}`,
      )
    } catch (error) {
      console.log(`  ${pad(label, 30)}failed: ${error.message}`)
    }
  }

  console.log(
    '\nIf nothing here finds it, the series is not on Hardcover under a name\n' +
      'resembling yours, and a manual override is the only fix.\n',
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
