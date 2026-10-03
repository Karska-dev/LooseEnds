#!/usr/bin/env node
/**
 * The experimental AI lookup, run from a laptop: shows what it finds for a
 * series and how that compares with Hardcover.
 *
 *   node scripts/ai-explain.mjs "Zodiac Academy" --author "Caroline Peckham"
 *   node scripts/ai-explain.mjs --all                    # the benchmark set
 *   node scripts/ai-explain.mjs --all --model gemma4:e4b # another local model
 *   node scripts/ai-explain.mjs --all --limit 5          # a quick first try
 *   node scripts/ai-explain.mjs --all --only "Zodiac,Bride"   # just these
 *
 * For each series: one web search (Tavily), a local model reads the pages
 * (Ollama), plain code keeps only what the pages say — the real pipeline in
 * src/shared/aiLookup.ts, not a copy of it. Then the same series is resolved
 * through Hardcover and the two lists are compared book by book.
 *
 * Technique: evaluation against a reference. Hardcover is used as the answer
 * key, and the two central figures have standard names. Recall is how much
 * of the reference was found ("All Hardcover entries found"); precision is
 * how much of what was found is in the reference ("AI books Hardcover also
 * has"). Either can be raised by giving up the other, so both are shown.
 *
 * Needs, in the environment or .env.local:
 *   TAVILY_KEY        — tavily.com, free, no card
 *   HARDCOVER_TOKEN   — optional; without it nothing is compared
 *   OLLAMA_MODEL      — optional, default qwen3.5:9b
 *   OLLAMA_URL        — optional, default http://localhost:11434
 *
 * Every web search, every model reply and every Hardcover answer is saved
 * under .dev-cache/ (git-ignored) and replayed next time. A series costs one
 * Tavily credit once, however often the prompt or the model changes; a run
 * that is interrupted picks up where it stopped; and a change to the
 * checking rules can be re-scored in seconds. --refresh searches again,
 * --rethink asks the model again. Hardcover requests made here are NOT
 * counted in the Worker's daily budget.
 *
 * --depth advanced uses Tavily's deeper search: two credits a series instead
 * of one, longer excerpts. Its searches are saved apart from the basic ones.
 *
 * --all reads .issue-bodies/ai-benchmark-series.json unless --file names
 * another list: { "series": [{ "name": "…", "author": "…" }] }.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { aiLookupSeries, normalise, pagesFromTavily, searchQueryFor, tavilyRequestBody } from '../src/shared/aiLookup.ts'
import { resolveSeriesNames } from '../src/shared/hardcover.ts'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const option = (name) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 ? argv[at + 1] : undefined
}
const VALUE_FLAGS = ['author', 'model', 'file', 'limit', 'depth', 'only']
const positional = argv.filter(
  (arg, index) => !arg.startsWith('--') && !VALUE_FLAGS.includes((argv[index - 1] ?? '').replace(/^--/, '')),
)

function setting(key) {
  if (process.env[key]) return process.env[key]
  if (!existsSync('.env.local')) return null
  const match = readFileSync('.env.local', 'utf8').match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm'))
  return match ? match[1].trim().replace(/^["']|["']$/g, '') || null : null
}

const TAVILY_KEY = setting('TAVILY_KEY')
const HARDCOVER_TOKEN = flag('no-hardcover') ? null : setting('HARDCOVER_TOKEN')
const MODEL = option('model') ?? setting('OLLAMA_MODEL') ?? 'qwen3.5:9b'
const OLLAMA_URL = (setting('OLLAMA_URL') ?? 'http://localhost:11434').replace(/\/$/, '')
const TODAY = new Date().toISOString().slice(0, 10)
const DEPTH = option('depth') === 'advanced' ? 'advanced' : 'basic'
const CACHE = '.dev-cache'

/**
 * Workers AI prices for the model the plan starts with
 * (@cf/meta/llama-3.3-70b-instruct-fp8-fast), in neurons per million tokens.
 * Only an estimate: a local model's token counts are close to, not the same
 * as, the production model's.
 */
const NEURONS_PER_M = { input: 26668, output: 204805 }

const all = flag('all')
if (!all && positional.length === 0) {
  console.error(
    'Usage: node scripts/ai-explain.mjs "<series name>" [--author "<author>"]\n' +
      '       node scripts/ai-explain.mjs --all [--limit N] [--only "name,name"] [--model <ollama model>] [--file <list.json>]\n' +
      'Flags: --refresh (search again), --rethink (ask the model again), --depth advanced, --no-hardcover',
  )
  process.exit(1)
}

const slug = (query) => normalise(`${query.name} ${query.author ?? ''}`).replace(/ /g, '-').slice(0, 120)
const pad = (value, width) => String(value ?? '').slice(0, width).padEnd(width)
const host = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function saveJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 1))
}

function stop(message) {
  console.error(`\n${message}`)
  process.exit(1)
}

// ---------- search: Tavily, saved and replayed ----------

const spent = { credits: 0, fresh: 0, replayed: 0 }

async function search(query, searchText) {
  // The second, differently worded search for a series is saved beside the first.
  const second = searchText === searchQueryFor(query) ? '' : '.again'
  const path = join(CACHE, 'tavily', `${slug(query)}${second}${DEPTH === 'advanced' ? '.advanced' : ''}.json`)
  const request = tavilyRequestBody(searchText, DEPTH)
  if (!flag('refresh')) {
    const saved = readJson(path)
    // Replayed only if it answers the same question: a saved search made
    // with other settings would quietly test yesterday's pipeline.
    if (saved && JSON.stringify(saved._request) === JSON.stringify(request)) {
      spent.replayed += 1
      return pagesFromTavily(saved)
    }
  }
  if (!TAVILY_KEY) stop('No TAVILY_KEY in the environment or .env.local, and no saved search for this series.')

  for (let attempt = 0; attempt < 4; attempt += 1) {
    let response
    try {
      response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { authorization: `Bearer ${TAVILY_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
    } catch (error) {
      // A dropped connection is not an answer. Wait and ask again.
      if (attempt === 3) throw new Error(`Tavily could not be reached: ${error?.cause?.code ?? error?.message ?? error}`)
      await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)))
      continue
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      const wait = Number(response.headers.get('retry-after')) || 10
      console.log(`  Tavily is rate limiting; waiting ${wait}s`)
      await new Promise((resolve) => setTimeout(resolve, wait * 1000))
      continue
    }
    if (response.status === 401) stop('Tavily rejected the key (HTTP 401). Check TAVILY_KEY in .env.local.')
    if (response.status === 432 || response.status === 433) {
      stop(`Tavily's plan limit is reached (HTTP ${response.status}). Saved searches still replay; new ones wait for next month.`)
    }
    if (!response.ok) stop(`Tavily answered HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)

    const body = await response.json()
    saveJson(path, { ...body, _request: request })
    spent.fresh += 1
    spent.credits += Number(body?.usage?.credits ?? (DEPTH === 'advanced' ? 2 : 1))
    return pagesFromTavily(body)
  }
  throw new Error('Tavily kept refusing. Try again in a minute.')
}

// ---------- extract: a local model through Ollama ----------

const tokens = { input: 0, output: 0 }
let sendThink = true

const modelUse = { fresh: 0, replayed: 0 }

/** The same model asked the same thing answers the same (temperature 0): keep it. */
async function runModel(request) {
  const key = createHash('sha1').update(`${MODEL}\n${request.system}\n${request.user}`).digest('hex').slice(0, 16)
  const path = join(CACHE, 'model', `${MODEL.replace(/[^a-z0-9.]+/gi, '-')}-${key}.json`)
  if (!flag('rethink')) {
    const saved = readJson(path)
    if (saved?.reply) {
      modelUse.replayed += 1
      tokens.input += saved.input ?? 0
      tokens.output += saved.output ?? 0
      lastModelSeconds = saved.seconds ?? 0
      return saved.reply
    }
  }
  const started = Date.now()
  const before = { ...tokens }
  const reply = await askOllama(request)
  lastModelSeconds = (Date.now() - started) / 1000
  modelUse.fresh += 1
  saveJson(path, { reply, input: tokens.input - before.input, output: tokens.output - before.output, seconds: lastModelSeconds })
  return reply
}

/** How long the model took for the last series, even when replayed. */
let lastModelSeconds = 0

async function askOllama(request) {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
    format: request.schema,
    // Streamed so a slow model cannot outlast fetch's wait for a response.
    stream: true,
    // Ollama's default context is small and cuts long prompts off silently,
    // which looks exactly like a model that cannot read.
    options: { num_ctx: 16384, temperature: 0 },
    ...(sendThink ? { think: false } : {}),
  }

  let response
  try {
    response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    stop(`Couldn't reach Ollama at ${OLLAMA_URL}. Is it running? Start the Ollama app, or run: ollama serve`)
  }

  if (!response.ok) {
    const text = await response.text()
    // Models without a thinking mode refuse the "think" setting outright.
    if (sendThink && /think/i.test(text)) {
      sendThink = false
      return askOllama(request)
    }
    if (response.status === 404) stop(`Ollama has no model "${MODEL}". Pull it first: ollama pull ${MODEL}`)
    stop(`Ollama answered HTTP ${response.status}: ${text.slice(0, 300)}`)
  }

  let reply = ''
  let buffered = ''
  const decoder = new TextDecoder()
  for await (const chunk of response.body) {
    buffered += decoder.decode(chunk, { stream: true })
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const part = JSON.parse(line)
      if (part.error) stop(`Ollama: ${part.error}`)
      reply += part.message?.content ?? ''
      if (part.done) {
        tokens.input += part.prompt_eval_count ?? 0
        tokens.output += part.eval_count ?? 0
      }
    }
  }
  return reply
}

// ---------- the same series from Hardcover, saved and replayed ----------

async function hardcoverFor(queries) {
  const answers = new Map()
  if (!HARDCOVER_TOKEN) return answers
  const missing = []
  for (const query of queries) {
    const saved = flag('refresh') ? null : readJson(join(CACHE, 'hardcover', `${slug(query)}.json`))
    if (saved) answers.set(query.name, saved)
    else missing.push(query)
  }
  for (let index = 0; index < missing.length; index += 10) {
    const batch = missing.slice(index, index + 10)
    console.log(`Asking Hardcover about ${batch.length} series (about ${batch.length + 4}s)…`)
    const results = await resolveSeriesNames(batch, HARDCOVER_TOKEN)
    results.forEach((result, at) => {
      answers.set(batch[at].name, result)
      // A failure is not a fact about the series; do not replay it.
      if (result.status !== 'error') saveJson(join(CACHE, 'hardcover', `${slug(batch[at])}.json`), result)
    })
  }
  return answers
}

// ---------- comparing the two lists ----------

const yearOf = (date) => (date ? date.slice(0, 4) : null)

function sameTitle(a, b) {
  const left = normalise(a)
  const right = normalise(b)
  if (!left || !right) return false
  if (left === right) return true
  // "The Awakening" against "Zodiac Academy: The Awakening".
  const [short, long] = left.length <= right.length ? [left, right] : [right, left]
  return short.length >= 6 && ` ${long} `.includes(` ${short} `)
}

function compare(ai, hardcover) {
  if (!hardcover || hardcover.status !== 'ok') return null
  const aiBooks = ai.volumes.map((volume) => ({
    position: volume.position,
    title: volume.editions[0].title,
    year: yearOf(volume.editions[0].releaseDate),
    used: false,
  }))
  const rows = hardcover.volumes.map((volume) => {
    const titles = volume.editions.map((edition) => edition.title)
    const match = aiBooks.find((book) => !book.used && titles.some((title) => sameTitle(title, book.title)))
    if (match) match.used = true
    // The first edition is the one the board shows; the earliest date across
    // every edition is too often a mis-entered reprint.
    const year = yearOf(volume.editions[0]?.releaseDate ?? null)
    return { position: volume.position, title: titles[0], year, match }
  })
  const matched = rows.filter((row) => row.match)
  const comparableYears = matched.filter((row) => row.year && row.match.year)
  return {
    rows,
    extra: aiBooks.filter((book) => !book.used),
    hardcoverBooks: rows.length,
    aiBooks: aiBooks.length,
    matched: matched.length,
    positionsRight: matched.filter((row) => Math.abs(row.position - row.match.position) < 0.01).length,
    yearsCompared: comparableYears.length,
    yearsRight: comparableYears.filter((row) => row.year === row.match.year).length,
    undated: matched.filter((row) => !row.match.year).length,
    // The numbered books proper: what "what comes next" is decided on.
    mainBooks: rows.filter((row) => Number.isInteger(row.position) && row.position >= 1).length,
    mainMatched: matched.filter((row) => Number.isInteger(row.position) && row.position >= 1).length,
    mainPositionsRight: matched.filter(
      (row) => Number.isInteger(row.position) && row.position >= 1 && Math.abs(row.position - row.match.position) < 0.01,
    ).length,
  }
}

// ---------- one series, told in full ----------

function explain(query, outcome, hardcover, comparison) {
  const { result, report, draft } = outcome
  console.log(`\n=== ${query.name}${query.author ? ` — ${query.author}` : ''} ===`)

  console.log(`\nSources read (${report.pages.length}): a "page" is the page itself, an "excerpt" only what the search quoted from it.`)
  for (const [index, page] of report.pages.entries()) {
    console.log(`  P${index + 1}  ${pad(host(page.url), 30)} ${pad(page.full ? 'page' : 'excerpt', 8)} ${String(page.chars).padStart(6)} chars  ${page.title.slice(0, 56)}`)
  }

  console.log(`\nThe model drafted ${report.drafted} book${report.drafted === 1 ? '' : 's'}; ${report.kept} survived the check against the pages.`)
  for (const item of report.dropped) console.log(`  dropped  "${item.title}" — ${item.reason}`)
  if (report.datesDropped > 0) console.log(`  ${report.datesDropped} date(s) were not next to their title on the page and were removed.`)
  if (report.resourced > 0) console.log(`  ${report.resourced} book(s) were on a different page from the one the model cited.`)

  if (result.status !== 'ok') {
    console.log(`\nResult: not found — ${result.detail}`)
    if (draft && draft.books.length > 0) {
      console.log('The draft was:')
      for (const book of draft.books) console.log(`  ${pad(book.position ?? '?', 5)}${book.title}`)
    }
  } else {
    console.log(`\nResult: ${result.matchedName} — ${result.totalBooks} main-line book(s)`)
    console.log(`  ${pad('#', 5)}${pad('title', 44)}${pad('released', 12)}${pad('audio', 28)}source`)
    for (const volume of result.volumes) {
      const edition = volume.editions[0]
      const audio = edition.hasAudio
        ? ['yes', edition.audio?.year, edition.audio?.publisher].filter(Boolean).join(' · ')
        : ''
      const date = edition.releaseDate ?? (edition.releasedInferred ? '? (out)' : '?')
      const place = `${volume.position}${volume.evidence.positionFrom === 'model' ? '~' : ''}`
      console.log(`  ${pad(place, 5)}${pad(edition.title, 44)}${pad(date, 12)}${pad(audio, 28)}${host(volume.evidence.url)}`)
    }
    if (report.numberedByModel > 0) console.log('  ~ no page numbers this book; its place is the model\'s reading of the list order.')
    if (result.readingOrder) console.log(`  Reading order: ${result.readingOrder.note} (${host(result.readingOrder.url)})`)
  }

  if (!hardcover) {
    console.log('\nNo Hardcover comparison (no HARDCOVER_TOKEN, or --no-hardcover).')
  } else if (hardcover.status !== 'ok') {
    console.log(`\nHardcover: ${hardcover.status}${hardcover.detail ? ` — ${hardcover.detail}` : ''}. Nothing to compare against.`)
  } else if (comparison) {
    console.log(`\nAgainst Hardcover (${hardcover.matchedName}, ${comparison.hardcoverBooks} entries):`)
    console.log(`  ${pad('#', 5)}${pad('Hardcover', 40)}${pad('year', 6)}  ${pad('AI', 40)}${pad('#', 5)}year`)
    for (const row of comparison.rows) {
      const match = row.match
      const position = match ? (Math.abs(row.position - match.position) < 0.01 ? match.position : `${match.position} ✗`) : ''
      const year = match ? (match.year ? (row.year && row.year !== match.year ? `${match.year} ✗` : match.year) : '?') : ''
      console.log(`  ${pad(row.position, 5)}${pad(row.title, 40)}${pad(row.year ?? '—', 6)}  ${pad(match ? match.title : '— missing —', 40)}${pad(position, 5)}${year}`)
    }
    for (const book of comparison.extra) {
      console.log(`  ${pad('', 5)}${pad('— not on Hardcover —', 40)}${pad('', 6)}  ${pad(book.title, 40)}${pad(book.position, 5)}${book.year ?? '?'}`)
    }
  }
  console.log(`\nTook ${(report.ms.search / 1000).toFixed(1)}s to search and ${lastModelSeconds.toFixed(1)}s for the model (${MODEL})${modelUse.replayed ? ', replayed from .dev-cache' : ''}.`)
}

// ---------- run ----------

let queries
if (all) {
  const file = option('file') ?? '.issue-bodies/ai-benchmark-series.json'
  const list = readJson(file)
  if (!list?.series?.length) stop(`No series list at ${file}. Expected { "series": [{ "name": "…", "author": "…" }] }.`)
  queries = list.series.map((item) => ({ name: item.name, author: item.author }))
  const only = option('only')
  if (only) {
    const wanted = only.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean)
    queries = queries.filter((query) => wanted.some((part) => query.name.toLowerCase().includes(part)))
    if (queries.length === 0) stop(`No series in ${file} matches --only "${only}".`)
  }
  const limit = Number(option('limit'))
  if (Number.isFinite(limit) && limit > 0) queries = queries.slice(0, limit)
} else {
  queries = [{ name: positional[0], author: option('author') }]
}

console.log(`AI lookup — model ${MODEL} via ${OLLAMA_URL}, ${queries.length} series, ${TODAY}`)
const hardcoverAnswers = await hardcoverFor(queries)

const lines = []
for (const [index, query] of queries.entries()) {
  const before = { ...tokens }
  lastModelSeconds = 0
  let outcome
  try {
    outcome = await aiLookupSeries(query, {
      today: TODAY,
      search: (text) => search(query, text),
      runModel,
    })
  } catch (error) {
    // One series failing — the network, usually — must not lose the rest.
    // What was fetched is saved, so running again only repeats this one.
    const message = error instanceof Error ? error.message : String(error)
    lines.push({ name: query.name, author: query.author ?? null, status: 'error', detail: message, kept: 0, dated: 0, dropped: [], datesDropped: 0, audioMarks: 0, seconds: 0, tokens: { input: 0, output: 0 }, numberedByModel: 0, comparison: null, hardcoverStatus: hardcoverAnswers.get(query.name)?.status ?? null, readingOrder: null })
    console.log(`${String(index + 1).padStart(2)}/${queries.length} ${pad(query.name, 30)} FAILED: ${message}`)
    continue
  }
  const used = { input: tokens.input - before.input, output: tokens.output - before.output }
  const hardcover = hardcoverAnswers.get(query.name) ?? null
  const comparison = outcome.result.status === 'ok' ? compare(outcome.result, hardcover) : null

  if (!all) explain(query, outcome, hardcover, comparison)

  const line = {
    name: query.name,
    author: query.author ?? null,
    status: outcome.result.status,
    detail: outcome.result.detail ?? null,
    pages: outcome.report.pages.map((page) => `${host(page.url)}${page.full ? '' : ' (excerpt)'}`),
    drafted: outcome.report.drafted,
    kept: outcome.report.kept,
    dropped: outcome.report.dropped,
    datesDropped: outcome.report.datesDropped,
    readingOrder: outcome.result.readingOrder ?? null,
    audioMarks: outcome.result.volumes.filter((volume) => volume.editions[0].hasAudio).length,
    dated: outcome.result.volumes.filter((volume) => volume.editions[0].releaseDate).length,
    hardcoverStatus: hardcover?.status ?? null,
    comparison: comparison && {
      hardcoverBooks: comparison.hardcoverBooks,
      matched: comparison.matched,
      positionsRight: comparison.positionsRight,
      yearsCompared: comparison.yearsCompared,
      yearsRight: comparison.yearsRight,
      undated: comparison.undated,
      mainBooks: comparison.mainBooks,
      mainMatched: comparison.mainMatched,
      mainPositionsRight: comparison.mainPositionsRight,
      missing: comparison.rows.filter((row) => !row.match).map((row) => `${row.position} ${row.title}`),
      extra: comparison.extra.map((book) => `${book.position} ${book.title}`),
    },
    books: outcome.result.volumes.map((volume) => ({
      position: volume.position,
      title: volume.editions[0].title,
      releaseDate: volume.editions[0].releaseDate,
      source: volume.evidence.url,
    })),
    seconds: Math.round((outcome.report.ms.search / 1000 + lastModelSeconds) * 10) / 10,
    numberedByModel: outcome.report.numberedByModel,
    tokens: used,
  }
  lines.push(line)

  if (all) {
    const versus = comparison
      ? `main ${comparison.mainPositionsRight}/${comparison.mainBooks} right, all ${comparison.matched}/${comparison.hardcoverBooks}, years ${comparison.yearsRight}/${comparison.yearsCompared}`
      : hardcover?.status === 'ok'
        ? 'nothing to compare'
        : `Hardcover: ${hardcover?.status ?? 'not asked'}`
    const found = line.status === 'ok' ? `${line.kept} books, ${line.dated} dated` : 'NOT FOUND'
    console.log(
      `${String(index + 1).padStart(2)}/${queries.length} ${pad(query.name, 30)} ${pad(found, 20)} ${pad(versus, 44)} ${String(line.seconds).padStart(5)}s`,
    )
  }
}

if (all) {
  const sum = (pick) => lines.reduce((total, line) => total + pick(line), 0)
  const found = lines.filter((line) => line.status === 'ok')
  const compared = lines.filter((line) => line.comparison)
  const onHardcover = lines.filter((line) => line.hardcoverStatus === 'ok')
  const hardcoverBooks = sum((line) => line.comparison?.hardcoverBooks ?? 0)
  const matched = sum((line) => line.comparison?.matched ?? 0)
  const aiBooks = sum((line) => (line.comparison ? line.kept : 0))
  const percent = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—')
  const perLookup = {
    input: Math.round(tokens.input / lines.length),
    output: Math.round(tokens.output / lines.length),
  }
  const neurons = Math.round((perLookup.input * NEURONS_PER_M.input + perLookup.output * NEURONS_PER_M.output) / 1e6)

  const failed = lines.filter((line) => line.status === 'error')
  const mainBooks = sum((line) => line.comparison?.mainBooks ?? 0)
  const mainRight = sum((line) => line.comparison?.mainPositionsRight ?? 0)
  const perfect = compared.filter((line) => line.comparison.mainBooks > 0 && line.comparison.mainPositionsRight === line.comparison.mainBooks)

  console.log(`\n=== ${MODEL}, ${DEPTH} search: ${lines.length} series ===`)
  if (failed.length > 0) console.log(`FAILED (run again to retry)   ${failed.length}: ${failed.map((line) => line.name).join(', ')}`)
  console.log(`Series found by AI            ${found.length} of ${lines.length} (${percent(found.length, lines.length)})`)
  if (onHardcover.length > 0) {
    console.log(`Compared with Hardcover       ${compared.length} series`)
    console.log(`Main books, right number      ${mainRight} of ${mainBooks} (${percent(mainRight, mainBooks)})   — books 1, 2, 3 …: found and numbered as on Hardcover`)
    console.log(`Series with every main book   ${perfect.length} of ${compared.length} (${percent(perfect.length, compared.length)})   — the whole numbered run right`)
    console.log(`All Hardcover entries found   ${matched} of ${hardcoverBooks} (${percent(matched, hardcoverBooks)})   — including novellas and extras`)
    console.log(`AI books Hardcover also has   ${matched} of ${aiBooks} (${percent(matched, aiBooks)})   — the rest are extras, other editions, or wrong`)
    console.log(`Years right                   ${sum((line) => line.comparison?.yearsRight ?? 0)} of ${sum((line) => line.comparison?.yearsCompared ?? 0)} compared (${percent(sum((line) => line.comparison?.yearsRight ?? 0), sum((line) => line.comparison?.yearsCompared ?? 0))})`)
  }
  console.log(`Series with at least one date ${found.filter((line) => line.dated > 0).length} of ${found.length} found   — with none, the board cannot tell what is out`)
  console.log(`Books with a date             ${sum((line) => line.dated)} of ${sum((line) => line.kept)}`)
  console.log(`Books numbered by the model   ${sum((line) => line.numberedByModel)} of ${sum((line) => line.kept)}   — no page gave a number; the rest were read off the pages`)
  console.log(`Books the check removed       ${sum((line) => line.dropped.length)}`)
  console.log(`Dates the check removed       ${sum((line) => line.datesDropped)}`)
  console.log(`Reading-order notes kept      ${lines.filter((line) => line.readingOrder).length}`)
  console.log(`Audiobook marks               ${sum((line) => line.audioMarks)}`)
  console.log(`Time per series               ${(sum((line) => line.seconds) / lines.length).toFixed(1)}s (${modelUse.fresh} model call(s) made now, ${modelUse.replayed} replayed)`)
  console.log(`Tokens per lookup             ${perLookup.input} in, ${perLookup.output} out`)
  console.log(`Workers AI estimate           ~${neurons} neurons per lookup → about ${neurons > 0 ? Math.floor(10000 / neurons) : '—'} lookups a day on the free 10,000`)
  console.log(`Tavily                        ${spent.fresh} new search(es), ${spent.credits} credit(s); ${spent.replayed} replayed from .dev-cache`)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const path = join(CACHE, 'reports', `ai-benchmark-${MODEL.replace(/[^a-z0-9.]+/gi, '-')}-${DEPTH}-${stamp}.json`)
  saveJson(path, { model: MODEL, depth: DEPTH, date: TODAY, tokens, perLookup, neuronsEstimate: neurons, tavily: spent, series: lines })
  console.log(`\nFull results: ${path}`)
} else if (tokens.input > 0) {
  const neurons = Math.round((tokens.input * NEURONS_PER_M.input + tokens.output * NEURONS_PER_M.output) / 1e6)
  console.log(`Tokens: ${tokens.input} in, ${tokens.output} out — about ${neurons} Workers AI neurons at production prices (estimate).`)
  console.log(`Tavily: ${spent.fresh ? `${spent.credits} credit(s) spent` : 'replayed from .dev-cache, no credit spent'}.`)
}
