import { useState } from 'react'
import type { ChangeEvent } from 'react'
import { parseGoodreadsCsv } from './goodreads'
import type { ParseResult } from './goodreads'
import { groupIntoSeries } from './series'
import type { SeriesSummary } from './series'
import { resolveAllSeries } from './resolve'
import type { SeriesResult } from './resolve'

const SHELF_LABELS: Record<string, string> = {
  read: 'Read',
  reading: 'Reading',
  to_read: 'To read',
  dnf: 'Did not finish',
}

export default function App() {
  const [result, setResult] = useState<ParseResult | null>(null)
  const [series, setSeries] = useState<SeriesSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    setBusy(true)
    setError(null)
    try {
      const text = await file.text()
      const parsed = parseGoodreadsCsv(text)
      if (parsed.books.length === 0) {
        setError("That file has no book rows. Is it the Goodreads library export?")
        setResult(null)
        setSeries(null)
      } else {
        setResult(parsed)
        setSeries(groupIntoSeries(parsed.books))
      }
    } catch {
      setError('That file could not be read. Try exporting it again from Goodreads.')
      setResult(null)
      setSeries(null)
    } finally {
      setBusy(false)
    }
  }

  const coverage = result
    ? Math.round((result.dateReadCoverage.withDate / Math.max(result.dateReadCoverage.total, 1)) * 100)
    : 0

  return (
    <main className="page">
      <header className="masthead">
        <h1>Loose Ends</h1>
        <p className="tagline">
          You&rsquo;ve read four. There are seven. Here&rsquo;s book five.
        </p>
      </header>

      <section className="intake">
        <h2>Your Goodreads export</h2>
        <input type="file" id="export-file" accept=".csv" onChange={handleFile} />
        <p className="note">
          Read here in your browser. Nothing is uploaded and nothing is stored.
        </p>
        {busy && <p className="note">Reading&hellip;</p>}
        {error && <p className="error">{error}</p>}
      </section>

      {result && (
        <>
          <section className="summary">
            <h2>What came through</h2>
            <dl className="tiles">
              {(['read', 'reading', 'to_read', 'dnf'] as const).map((shelf) => (
                <div className="tile" key={shelf}>
                  <dt>{SHELF_LABELS[shelf]}</dt>
                  <dd>{result.counts[shelf]}</dd>
                </div>
              ))}
            </dl>
            <p className="note">
              {result.dateReadCoverage.withDate} of {result.dateReadCoverage.total} read
              books have a date ({coverage}%).
              {coverage < 60 && ' Monthly statistics will be patchy — Goodreads leaves this blank often.'}
              {result.skipped > 0 && ` ${result.skipped} rows skipped.`}
            </p>
          </section>

          {series && <SeriesReport summary={series} />}

          <section className="preview">
            <h2>First 20 books</h2>
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Author</th>
                    <th>Shelf</th>
                    <th>Read</th>
                  </tr>
                </thead>
                <tbody>
                  {result.books.slice(0, 20).map((book, index) => (
                    <tr key={`${book.title}-${index}`}>
                      <td>{book.title}</td>
                      <td>{book.author}</td>
                      <td>
                        <span className={`pill pill-${book.shelf}`}>
                          {SHELF_LABELS[book.shelf]}
                        </span>
                      </td>
                      <td className="num">{book.dateRead ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <footer className="colophon">
        Series data from Wikidata, Open Library and Google Books.
      </footer>
    </main>
  )
}

function SeriesReport({ summary }: { summary: SeriesSummary }) {
  const started = summary.groups.filter((group) => group.readCount > 0)
  const matchPercent = Math.round(summary.matchRate * 100)
  const [resolved, setResolved] = useState<Map<string, SeriesResult>>(new Map())
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  async function resolveAll() {
    setProgress({ done: 0, total: started.length })
    const results = await resolveAllSeries(
      started.map((group) => ({ key: group.key, name: group.name, author: group.author })),
      (done, total, soFar) => {
        setResolved(soFar)
        setProgress({ done, total })
      },
    )
    setResolved(results)
    setProgress(null)
  }

  const tally = { ok: 0, not_found: 0, error: 0 }
  for (const entry of resolved.values()) tally[entry.status] += 1

  return (
    <section className="summary">
      <h2>Series</h2>
      <dl className="tiles">
        <div className="tile">
          <dt>Series found</dt>
          <dd>{summary.groups.length}</dd>
        </div>
        <div className="tile">
          <dt>Started</dt>
          <dd>{started.length}</dd>
        </div>
        <div className="tile">
          <dt>Matched</dt>
          <dd>{matchPercent}%</dd>
        </div>
        <div className="tile">
          <dt>No series</dt>
          <dd>{summary.unmatched.length}</dd>
        </div>
      </dl>
      <p className="note">
        {matchPercent}% of titles carry a series in the Goodreads title string.
        The rest are standalones or books Goodreads never tagged.
      </p>

      <div className="actions">
        <button type="button" onClick={resolveAll} disabled={progress !== null}>
          {progress
            ? `Looking up\u2026 ${progress.done} of ${progress.total}`
            : `Look up ${started.length} series on Hardcover`}
        </button>
        {progress && (
          <div
            className="meter"
            role="progressbar"
            aria-valuenow={progress.done}
            aria-valuemin={0}
            aria-valuemax={progress.total}
          >
            <span style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
        )}
        {resolved.size > 0 && progress === null && (
          <span className="note">
            {tally.ok} found &middot; {tally.not_found} not matched
            {tally.error > 0 && ` \u00b7 ${tally.error} failed (try again)`}
            {firstDetail(resolved) && ` \u2014 ${firstDetail(resolved)}`}
          </span>
        )}
      </div>

      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Series</th>
              <th>Read</th>
              <th>Furthest</th>
              <th>Volumes</th>
              <th>Latest</th>
            </tr>
          </thead>
          <tbody>
            {started.slice(0, 30).map((group) => (
              <tr key={group.key}>
                <td>
                  {group.name}
                  {group.hasDnf && <span className="pill pill-dnf">DNF</span>}
                </td>
                <td className="num">{group.readCount}</td>
                <td className="num">
                  {group.highestReadPosition !== null ? `#${group.highestReadPosition}` : '\u2014'}
                </td>
                <td className="num">{volumeCount(resolved, group.key)}</td>
                <td className="num">{latestDate(resolved, group.key)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function volumeCount(resolved: Map<string, SeriesResult>, key: string): string {
  const entry = resolved.get(key)
  if (!entry) return '\u00b7\u00b7\u00b7'
  if (entry.status === 'error') return '!'
  if (entry.volumes.length === 0) return '?'
  return String(entry.totalBooks ?? entry.volumes.length)
}

function latestDate(resolved: Map<string, SeriesResult>, key: string): string {
  const dates = (resolved.get(key)?.volumes ?? [])
    .map((volume) => volume.releaseDate)
    .filter((date): date is string => date !== null)
  if (dates.length === 0) return '\u2014'
  return dates.sort().at(-1)!.slice(0, 4)
}

function firstDetail(resolved: Map<string, SeriesResult>): string | null {
  for (const entry of resolved.values()) {
    if (entry.status === 'error' && entry.detail) return entry.detail
  }
  return null
}
