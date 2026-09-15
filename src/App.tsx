import { useState } from 'react'
import type { ChangeEvent } from 'react'
import { parseGoodreadsCsv } from './goodreads'
import type { ParseResult } from './goodreads'

const SHELF_LABELS: Record<string, string> = {
  read: 'Read',
  reading: 'Reading',
  to_read: 'To read',
  dnf: 'Did not finish',
}

export default function App() {
  const [result, setResult] = useState<ParseResult | null>(null)
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
      } else {
        setResult(parsed)
      }
    } catch {
      setError('That file could not be read. Try exporting it again from Goodreads.')
      setResult(null)
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
