#!/usr/bin/env node
/**
 * Removes cached series so the next lookup has to go upstream. A fully warm
 * cache hides a broken Hardcover token indefinitely — the site looks healthy
 * until the first visitor arrives with a series nobody has looked up.
 *
 *   node scripts/evict-cache.mjs export.csv                 # show one, change nothing
 *   node scripts/evict-cache.mjs export.csv --run           # evict one
 *   node scripts/evict-cache.mjs export.csv --limit 5 --run
 *   node scripts/evict-cache.mjs export.csv --all --run     # the whole library
 *   node scripts/evict-cache.mjs --key "mistborn|brandon sanderson" --run
 *   node scripts/evict-cache.mjs export.csv --run --local   # the dev database
 *
 * Keys come from the Worker's own cacheKey(), so this cannot drift from what
 * the cache actually stores.
 */

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import Papa from 'papaparse'
import { cacheKey } from '../worker/cache.ts'

const DATABASE = 'looseends-cache'

const args = process.argv.slice(2)
const csvPath = args.find((a) => !a.startsWith('--') && a !== valueOf('key') && a !== valueOf('limit'))
const flag = (name) => args.includes(`--${name}`)
function valueOf(name) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

const explicitKey = valueOf('key')
const limit = flag('all') ? Infinity : Number(valueOf('limit') ?? 1)
const apply = flag('run')
const target = flag('local') ? '--local' : '--remote'

const SERIES_PATTERN = /\s*\(([^()]+?),?\s*#(\d+(?:\.\d+)?)(\s*-\s*\d+(?:\.\d+)?)?\)\s*$/

/** Mirrors the client: one entry per series, author from its most-read book. */
function keysFromExport(path) {
  const parsed = Papa.parse(readFileSync(path, 'utf8'), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  })

  const byName = new Map()
  for (const row of parsed.data) {
    const title = row['Title']?.trim()
    if (!title || row['Exclusive Shelf']?.trim() !== 'read') continue
    const match = title.match(SERIES_PATTERN)
    if (!match) continue
    const name = match[1].trim()
    if (!byName.has(name)) byName.set(name, row['Author']?.trim() || undefined)
  }

  return [...byName.entries()].map(([name, author]) => ({
    name,
    author,
    key: cacheKey(name, author),
  }))
}

function d1(sql) {
  return execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', DATABASE, target, '--command', sql],
    { encoding: 'utf8', stdio: apply ? 'inherit' : 'pipe' },
  )
}

function main() {
  if (!csvPath && !explicitKey) {
    console.error(
      'Usage: node scripts/evict-cache.mjs <goodreads_export.csv> [--limit N | --all] [--run] [--local]\n' +
        '       node scripts/evict-cache.mjs --key "<cache key>" --run',
    )
    process.exit(1)
  }

  const entries = explicitKey
    ? [{ name: explicitKey, author: undefined, key: explicitKey }]
    : keysFromExport(csvPath).slice(0, limit)

  if (entries.length === 0) {
    console.error('No series found in that export.')
    process.exit(1)
  }

  console.log(`\n${apply ? 'Evicting' : 'Would evict'} ${entries.length} cached series` +
    ` from ${DATABASE} (${target.replace('--', '')}):\n`)
  for (const entry of entries) {
    console.log(`  ${entry.name}${entry.author ? ` — ${entry.author}` : ''}`)
    console.log(`    key: ${entry.key}`)
  }

  const list = entries.map((entry) => `'${entry.key.replace(/'/g, "''")}'`).join(', ')
  const sql = `DELETE FROM series_cache WHERE cache_key IN (${list})`

  if (!apply) {
    console.log(`\nNothing changed. Add --run to apply:\n\n  ${sql}\n`)
    return
  }

  d1(sql)
  console.log(
    `\nDone. The next lookup of ${entries.length === 1 ? 'that series' : 'those series'}` +
      ' goes upstream — watch for upstreamFetches > 0 in the logs.\n' +
      'A cache miss that resolves is the only proof the deployed token works.\n',
  )
}

main()
