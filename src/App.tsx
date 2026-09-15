export default function App() {
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
        <input type="file" id="export-file" accept=".csv" disabled />
        <p className="note">
          Reading the file is the next step. When it lands, your library is parsed
          here in the browser &mdash; it is never uploaded and never stored.
        </p>
      </section>

      <footer className="colophon">
        Series data from Wikidata, Open Library and Google Books.
      </footer>
    </main>
  )
}
