# Loose Ends

Find the book series you never finished. Drop in your Goodreads export —
it's parsed in your browser, never uploaded.

**Status:** early development. Not usable yet.

## What it does

Most reading trackers think in books. Loose Ends thinks in *series*: which
ones you're part-way through, which volume comes next, and whether that
volume is published, announced for a future date, or not announced at all.

## How it works

Your Goodreads CSV export is read entirely in the browser. Series data comes
from Wikidata, Open Library and Google Books — all public, all queried
directly from the page. There is no backend, no account, and nothing is
stored: close the tab and the data is gone.

## Getting your Goodreads export

**My Books → Tools → Import and export → Export Library.** Desktop browser
only; the mobile app has no export. Don't open the file in Excel first —
it mangles ISBNs and dates.

## Why there's no "log in with Goodreads"

Goodreads retired its API in December 2020 and issues no new keys. Its terms
prohibit "data mining, robots, or similar data gathering and extraction
tools", so logging in on your behalf and scraping your shelves is off the
table. The CSV export is your own data, offered officially — that's the
supported path, and it's richer than the API ever was.

## Development

```bash
npm install
npm run dev
```

## License

MIT
