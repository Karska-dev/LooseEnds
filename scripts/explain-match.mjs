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
import {
  bestHit,
  bestHitByAuthor,
  byAnotherAuthor,
  editionsByPosition,
  nameCloseness,
  nameRelated,
  withOriginals,
} from '../src/shared/hardcover.ts'

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

/** Same surname — enough to count "hits by this author" in the report. */
const sameAuthorLoose = (a, b) => {
  const last = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').pop()
  return Boolean(a) && Boolean(b) && last(a) === last(b)
}

const pad = (value, width) => String(value ?? '').slice(0, width).padEnd(width)

function table(hits) {
  console.log(`  ${pad('#', 3)}${pad('name', 42)}${pad('author', 22)}${pad('books', 7)}${pad('readers', 9)}name is`)
  hits.forEach((hit, index) => {
    console.log(
      `  ${pad(index + 1, 3)}${pad(hit.name, 42)}${pad(hit.author_name, 22)}` +
        `${pad(hit.primary_books_count ?? 0, 7)}${pad(hit.readers_count ?? 0, 9)}` +
        (nameRelated(hit.name, name) ? ['the same', 'the same but for generic words', 'related'][nameCloseness(hit.name, name)] : '—'),
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

  if (author) {
    const mine = hits.filter((hit) => sameAuthorLoose(hit.author_name, author)).length
    console.log(`\nHits by ${author}: ${mine} of ${hits.length}` +
      (mine === 0 && hits.length > 0 ? '  ← none: the author cannot decide, so the name and readers do' : ''))
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

  const describe = (hit) =>
    hit
      ? `"${hit.name}" by ${hit.author_name ?? '?'} (${hit.primary_books_count ?? 0} books, ${hit.readers_count ?? 0} readers)`
      : 'nothing'
  let winner = bestHit(hits, name, author)
  console.log(`\nPicked: ${describe(winner)}`)

  // The same second search the Worker makes: only when the pick is by
  // somebody other than the reader's author.
  if (byAnotherAuthor(winner, author)) {
    const text = `${name} ${author}`
    console.log(`\nThat is not by ${author}, so the app searches again for: "${text}"`)
    await new Promise((r) => setTimeout(r, 1100))
    const again = await search(text, PER_PAGE)
    if (again.length === 0) console.log('  nothing came back.')
    else table(again)
    const theirs = bestHitByAuthor(again, name, author)
    console.log(
      theirs
        ? `\nPicked instead: ${describe(theirs)}`
        : `\nNothing there is both by ${author} and named like "${name}", so the first pick stands.`,
    )
    winner = theirs ?? winner
  }

  if (winner && (winner.primary_books_count ?? 0) === 0) {
    console.log('  ⚠ zero books: this resolves to an empty volume list, which the app shows as unmatched.')
  }

  // Phase 2. A correct match still yields nothing if the volumes carry no
  // positions, and the app cannot tell that apart from "not found".
  if (winner && (winner.primary_books_count ?? 0) > 0) {
    // The same flat queries the Worker sends (depth 3 at most).
    const ask = async (query) => {
      await new Promise((r) => setTimeout(r, 1100))
      const body = await fetch('https://api.hardcover.app/v1/graphql', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
      }).then((r) => r.json())
      if (body.errors?.length) throw new Error(body.errors[0].message)
      return body.data
    }
    const id = Number(winner.id)
    const first = await ask(
      `query { series(where: {id: {_eq: ${id}}}) { id name primary_books_count } book_series(where: {series_id: {_eq: ${id}}}, order_by: {position: asc}) { position book_id } }`,
    )
    const links = first.book_series ?? []
    const bookIds = [...new Set(links.map((l) => l.book_id))]
    const books = new Map()
    for (let at = 0; at < bookIds.length; at += 250) {
      const data = await ask(
        `query { books(where: {id: {_in: [${bookIds.slice(at, at + 250).join(', ')}]}}) { id canonical_id title slug release_date users_read_count image { url color } default_ebook_edition { language_id } default_physical_edition { language_id } default_audio_edition { language_id release_date } } }`,
      )
      for (const book of data.books ?? []) books.set(book.id, book)
    }
    // The originals of duplicate records, when the series does not link them.
    const missing = [
      ...new Set([...books.values()].map((b) => b.canonical_id).filter((x) => typeof x === 'number' && !books.has(x))),
    ]
    const fetchedOriginals = new Set(missing)
    for (let at = 0; at < missing.length; at += 250) {
      const data = await ask(
        `query { books(where: {id: {_in: [${missing.slice(at, at + 250).join(', ')}]}}) { id canonical_id title slug release_date users_read_count image { url color } default_ebook_edition { language_id } default_physical_edition { language_id } default_audio_edition { language_id release_date } } }`,
      )
      for (const book of data.books ?? []) books.set(book.id, book)
    }

    // Extra signals the app does not use yet. Each is asked for on its own,
    // so a field Hardcover does not have costs one column, not the report.
    const extra = async (label, query) => {
      try {
        return await ask(query)
      } catch (error) {
        console.log(`  (could not ask for ${label}: ${error.message})`)
        return null
      }
    }
    const featured = new Map()
    const flags = new Map()
    const englishEdition = new Map()
    const linkExtra = await extra(
      'featured',
      `query { book_series(where: {series_id: {_eq: ${id}}}) { book_id featured } }`,
    )
    for (const link of linkExtra?.book_series ?? []) featured.set(link.book_id, link.featured)
    for (let at = 0; at < bookIds.length; at += 250) {
      const chunk = bookIds.slice(at, at + 250).join(', ')
      const bookExtra = await extra(
        'compilation / canonical_id',
        `query { books(where: {id: {_in: [${chunk}]}}) { id compilation canonical_id } }`,
      )
      for (const book of bookExtra?.books ?? []) flags.set(book.id, book)
      const editionExtra = await extra(
        'any English edition',
        `query { books(where: {id: {_in: [${chunk}]}}) { id editions(where: {language_id: {_eq: 1}}, limit: 1) { id } } }`,
      )
      for (const book of editionExtra?.books ?? []) englishEdition.set(book.id, (book.editions ?? []).length > 0)
    }
    const yesNo = (value) => (value === undefined || value === null ? '?' : value ? 'yes' : 'no')

    const node = {
      name: first.series?.[0]?.name ?? winner.name,
      primary_books_count: first.series?.[0]?.primary_books_count ?? null,
      // What the app builds: a copy stands for its original (withOriginals).
      book_series: withOriginals(links, books),
    }
    // What Hardcover links, copies and all — the table below shows these.
    const entries = links.map((l) => ({ position: l.position, book: books.get(l.book_id) ?? null }))
    console.log(
      `\n${missing.length} original${missing.length === 1 ? '' : 's'} fetched that the series does not link itself` +
        (missing.length > 0 ? ` (${[...fetchedOriginals].slice(0, 12).join(', ')}${missing.length > 12 ? ', …' : ''})` : ''),
    )
    console.log(
      `\nVolumes on "${node.name}" (${entries.length} entries, ` +
        `${node.primary_books_count ?? '?'} primary books by Hardcover's count):`,
    )

    if (entries.length === 0) {
      console.log('  none — the series record exists but has no books attached.')
    } else {
      const lang = (book) => book?.default_ebook_edition?.language_id ?? book?.default_physical_edition?.language_id ?? null
      console.log(
        '  lang = language of the default edition (what the app goes by) · feat = this is the\n' +
          '  book\'s featured series · comp = compilation · canon = a copy of this book id (the app\n' +
          '  shows the original instead) · anyEn = some edition is tagged English\n',
      )
      console.log(
        `  ${pad('pos', 7)}${pad('title', 46)}${pad('date', 12)}${pad('lang', 6)}${pad('readers', 9)}` +
          `${pad('id', 9)}${pad('feat', 6)}${pad('comp', 6)}${pad('canon', 9)}anyEn`,
      )
      for (const entry of entries) {
        const position = entry.position === null ? 'null' : String(entry.position)
        const l = lang(entry.book)
        const bookId = entry.book?.id
        console.log(
          `  ${pad(position, 7)}${pad(entry.book?.title ?? '(no book)', 46)}` +
            `${pad(entry.book?.release_date ?? '', 12)}${pad(l === null ? '?' : l === 1 ? 'en' : l, 6)}` +
            `${pad(entry.book?.users_read_count ?? 0, 9)}${pad(bookId ?? '', 9)}` +
            `${pad(yesNo(featured.get(bookId)), 6)}${pad(yesNo(flags.get(bookId)?.compilation), 6)}` +
            `${pad(flags.get(bookId)?.canonical_id ?? '-', 9)}${yesNo(englishEdition.get(bookId))}`,
        )
      }

      // What the board shows: the English edition, else the most-read one.
      console.log('\n  What the app shows at each position, copies replaced by their originals\n  (en = tagged English on Hardcover):')
      for (const volume of editionsByPosition(node)) {
        const english = volume.editions.find((e) => e.languageId === 1)
        const shown = english ?? volume.editions[0]
        const why = english
          ? 'en'
          : `no edition tagged English among ${volume.editions.length} → most-read (lang ${shown.languageId ?? '?'}, ${shown.readers} readers)`
        console.log(`  ${pad(volume.position, 7)}${pad(shown.title, 46)}${why}`)
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
        `  ${pad(label, 30)}${pick ? `"${pick.name}" by ${pick.author_name ?? '?'} (${books} books)` : 'nothing'}` +
          `${flag}  [${alt.length} hits${author ? `, ${alt.filter((hit) => sameAuthorLoose(hit.author_name, author)).length} by this author` : ''}]`,
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
