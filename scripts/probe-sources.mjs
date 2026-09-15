#!/usr/bin/env node
/**
 * Measures how well each candidate source can answer the one question this app
 * asks: given a series name and author, which volumes exist and in what order?
 *
 *   node scripts/probe-sources.mjs ~/Downloads/goodreads_library_export.csv
 *   node scripts/probe-sources.mjs export.csv --sample 40
 *   node scripts/probe-sources.mjs export.csv --only wikidata,bookbrainz
 *   node scripts/probe-sources.mjs export.csv --all --markdown
 *
 * Tokens come from .env.local. Sources without one are skipped, not failed.
 */

import { readFileSync, existsSync } from 'node:fs'
import Papa from 'papaparse'

// ---------------------------------------------------------------- config

const args = process.argv.slice(2)
const csvPath = args.find((a) => !a.startsWith('--'))
const flag = (name) => args.includes(`--${name}`)
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const SAMPLE = flag('all') ? Infinity : Number(value('sample', 25))
const ONLY = value('only', '').split(',').filter(Boolean)
const AS_MARKDOWN = flag('markdown')

/** A source "found" a series only if it returns 2+ ordered volumes. One book
 *  with no siblings cannot answer "what comes next". */
const MIN_VOLUMES = 2

function loadEnv() {
  const env = {}
  if (!existsSync('.env.local')) return env
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, '')
  }
  return env
}
const ENV = { ...loadEnv(), ...process.env }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Wikidata rejects requests without a descriptive User-Agent with a bare 403,
 * and Node's default agent is not descriptive. Browsers cannot set this header
 * at all, which is one reason Wikidata belongs on the server side.
 */
const USER_AGENT =
  'LooseEnds-SourceProbe/0.1 (https://github.com/Karska-dev/LooseEnds) node-fetch'

async function getJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { 'User-Agent': USER_AGENT, ...(init.headers ?? {}) },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

// ------------------------------------------------------- series extraction

const SERIES_PATTERN =
  /\s*\(([^()]+?),?\s*#(\d+(?:\.\d+)?)(\s*-\s*\d+(?:\.\d+)?)?\)\s*$/

function seriesFromExport(path) {
  const parsed = Papa.parse(readFileSync(path, 'utf8'), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  })

  const byKey = new Map()
  for (const row of parsed.data) {
    const title = row['Title']?.trim()
    if (!title || row['Exclusive Shelf']?.trim() !== 'read') continue
    const match = title.match(SERIES_PATTERN)
    if (!match) continue

    const name = match[1].trim()
    const key = name.toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim()
    const entry = byKey.get(key) ?? { name, author: row['Author']?.trim() ?? '', count: 0 }
    entry.count += 1
    byKey.set(key, entry)
  }

  // Most-read series first: those are the ones coverage actually matters for.
  return [...byKey.values()].sort((a, b) => b.count - a.count)
}

// ------------------------------------------------------------------ sources

const sources = {}

// --- Hardcover: the incumbent, as a baseline to measure others against.
sources.hardcover = {
  needs: 'HARDCOVER_TOKEN',
  gapMs: 1100,
  async probe({ name, author }) {
    const gql = async (query) => {
      const body = await getJson('https://api.hardcover.app/v1/graphql', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${ENV.HARDCOVER_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query }),
      })
      if (body.errors?.length) throw new Error(body.errors[0].message)
      return body.data
    }

    const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const search = await gql(
      `query { search(query: "${escaped}", query_type: "series", per_page: 15, page: 1) { results } }`,
    )
    const hits = (search.search?.results?.hits ?? []).map((h) => h.document)
    const withBooks = hits.filter((h) => (h.primary_books_count ?? 0) > 0)
    const related = withBooks.filter((h) => sameish(h.name, name))
    const pool = related.length ? related : withBooks
    const best = pool.sort((a, b) => (b.readers_count ?? 0) - (a.readers_count ?? 0))[0]
    if (!best) return { volumes: 0 }

    await sleep(1100)
    const detail = await gql(
      `query { series_by_pk(id: ${Number(best.id)}) { book_series(order_by: {position: asc}) { position } } }`,
    )
    const positions = new Set(
      (detail.series_by_pk?.book_series ?? [])
        .map((e) => e.position)
        .filter((p) => Number.isInteger(p) && p >= 1),
    )
    return { volumes: positions.size, matched: best.name }
  },
}

// --- Wikidata: Action API for the id, SPARQL for members.
sources.wikidata = {
  gapMs: 600,
  async probe({ name }) {
    const search = await getJson(
      `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name)}` +
        `&language=en&type=item&limit=10&format=json&origin=*`,
    )
    const hit =
      (search.search ?? []).find((r) => /series|trilogy|saga|cycle/i.test(r.description ?? '')) ??
      (search.search ?? [])[0]
    if (!hit) return { volumes: 0 }

    const sparql = `SELECT ?book WHERE {
      { ?book wdt:P179 wd:${hit.id} } UNION { wd:${hit.id} wdt:P527 ?book }
    } LIMIT 200`
    const body = await getJson(
      `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`,
      { headers: { Accept: 'application/sparql-results+json' } },
    )
    return { volumes: (body.results?.bindings ?? []).length, matched: hit.label }
  },
}

// --- Open Library: does the `series` field come back populated?
sources.openlibrary = {
  gapMs: 300,
  async probe({ name, author }) {
    const query = `${name} ${author}`.trim()
    const body = await getJson(
      `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}` +
        `&fields=title,author_name,series&limit=40`,
    )
    const inSeries = (body.docs ?? []).filter((d) =>
      (d.series ?? []).some((s) => sameish(s, name)),
    )
    return { volumes: inSeries.length }
  },
}

// --- Google Books: volumeInfo.seriesInfo, if it means what we need.
sources.googlebooks = {
  needs: 'VITE_GOOGLE_BOOKS_KEY',
  gapMs: 400,
  async probe({ name, author }) {
    const key = ENV.VITE_GOOGLE_BOOKS_KEY
    const query = `${name} ${author}`.trim()
    const body = await getJson(
      `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}` +
        `&maxResults=40&key=${key}`,
    )
    const ids = new Map()
    for (const item of body.items ?? []) {
      const series = item.volumeInfo?.seriesInfo?.volumeSeries?.[0]
      if (!series?.seriesId) continue
      ids.set(series.seriesId, (ids.get(series.seriesId) ?? 0) + 1)
    }
    const biggest = [...ids.values()].sort((a, b) => b - a)[0] ?? 0
    return { volumes: biggest }
  },
}

// --- BookBrainz: MusicBrainz for books. Has a first-class Series entity.
sources.bookbrainz = {
  gapMs: 400,
  async probe({ name }) {
    const search = await getJson(
      `https://api.bookbrainz.org/1/search?q=${encodeURIComponent(name)}&type=series&limit=5`,
    )
    const hit = (search.searchResult ?? search.results ?? []).find((r) =>
      sameish(r.defaultAlias?.name ?? r.name ?? '', name),
    )
    if (!hit) return { volumes: 0 }
    const bbid = hit.bbid ?? hit.id
    const detail = await getJson(`https://api.bookbrainz.org/1/series/${bbid}?entities=true`)
    return { volumes: (detail.entities ?? detail.seriesItems ?? []).length, matched: hit.defaultAlias?.name }
  },
}

// --- LibraryThing: strong community series data, but a keyed feed.
sources.librarything = {
  needs: 'LIBRARYTHING_KEY',
  gapMs: 1000,
  async probe({ name }) {
    const response = await fetch(
      `https://www.librarything.com/services/rest/1.1/?method=librarything.ck.getwork` +
        `&name=${encodeURIComponent(name)}&apikey=${ENV.LIBRARYTHING_KEY}`,
      { headers: { 'User-Agent': USER_AGENT } },
    )
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const xml = await response.text()
    const matches = xml.match(/<fact>[\s\S]*?<\/fact>/g) ?? []
    return { volumes: matches.length }
  },
}

function sameish(a, b) {
  const norm = (v) => String(v).toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim()
  const left = norm(a)
  const right = norm(b)
  return left.includes(right) || right.includes(left)
}

// --------------------------------------------------------------------- run

async function main() {
  if (!csvPath) {
    console.error('Usage: node scripts/probe-sources.mjs <goodreads_export.csv> [--sample N] [--all] [--only a,b] [--markdown]')
    process.exit(1)
  }

  const all = seriesFromExport(csvPath)
  const series = all.slice(0, SAMPLE)
  console.error(`Found ${all.length} started series; probing ${series.length}.\n`)

  const names = (ONLY.length ? ONLY : Object.keys(sources)).filter((n) => sources[n])
  const report = []

  for (const sourceName of names) {
    const source = sources[sourceName]
    if (source.needs && !ENV[source.needs]) {
      report.push({ source: sourceName, skipped: `no ${source.needs}` })
      console.error(`${sourceName}: skipped, no ${source.needs}`)
      continue
    }

    let found = 0
    let thin = 0
    let missing = 0
    let errors = 0
    const started = Date.now()

    for (const item of series) {
      try {
        const { volumes } = await source.probe(item)
        if (volumes >= MIN_VOLUMES) found += 1
        else if (volumes > 0) thin += 1
        else missing += 1
      } catch (error) {
        errors += 1
        if (errors <= 2) console.error(`  ${sourceName} / ${item.name}: ${error.message}`)
      }
      await sleep(source.gapMs ?? 300)
      process.stderr.write(`\r  ${sourceName}: ${found + thin + missing + errors}/${series.length}   `)
    }

    process.stderr.write('\n')
    report.push({
      source: sourceName,
      found,
      thin,
      missing,
      errors,
      pct: Math.round((found / series.length) * 100),
      seconds: Math.round((Date.now() - started) / 1000),
    })
  }

  console.error('')
  if (AS_MARKDOWN) {
    console.log(`| Source | Usable | Thin | None | Errors | Coverage |`)
    console.log(`|---|---|---|---|---|---|`)
    for (const row of report) {
      if (row.skipped) {
        console.log(`| ${row.source} | — | — | — | — | skipped (${row.skipped}) |`)
      } else {
        console.log(`| ${row.source} | ${row.found} | ${row.thin} | ${row.missing} | ${row.errors} | **${row.pct}%** |`)
      }
    }
  } else {
    console.table(report)
  }
  console.error(`\nUsable = ${MIN_VOLUMES}+ ordered volumes. Thin = 1 volume, cannot answer "what next".`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
