# Loose Ends

Find the book series you never finished. Drop in your Goodreads export —
it's parsed in your browser, never uploaded.

![The series board: series sorted by what needs your attention, with the next unread volume in each](docs/series-board.png)

## Why

Every reading tracker thinks in books. Almost none of them think in **series**,
which is how a lot of fiction is actually read. Loose Ends answers one question:
*which series am I part-way through, and what comes next?*

For each series it shows how many you've read, which volume is next, and whether
that volume is out, announced for a future date, or not announced at all — the
last of which is a real answer, not a gap.

## How it works

Your Goodreads CSV is read **entirely in the browser**. Series names come out of
the Goodreads title strings, and volume lists come from
[Hardcover](https://hardcover.app) through a small server function that holds the
API token. Nothing about you is uploaded and nothing is stored: close the tab and
it's gone.

## Why Hardcover

Four sources were measured against a real 73-series library before picking one.

| Source | Result | Why |
|---|---|---|
| Goodreads API | gone | retired in 2020, no new keys, and their terms forbid automated access |
| Wikidata | 8 of 73 | encyclopedic: strong on canonical fiction, absent for indie and genre series |
| Open Library | books, no series | indexes the titles, doesn't curate series structure |
| Google Books | wrong meaning | `seriesInfo` describes Google's own collected editions, not the author's series |
| **Hardcover** | **71 of 73** | a community tracker built around series |

If your reading is mostly prize-list literary fiction, Wikidata would serve you
fine. For contemporary genre fiction — romantasy, progression fantasy, anything
indie — it has almost nothing, and that gap is what decided the architecture.

## Getting your Goodreads export

**My Books → Tools → Import and export → Export Library.**

Desktop browser only; the mobile app has no export. Don't open the file in Excel
first — it mangles ISBNs and dates.

## Why there's no "log in with Goodreads"

Goodreads retired its API in December 2020 and issues no new keys. Its terms
prohibit "data mining, robots, or similar data gathering and extraction tools",
so logging in on your behalf and reading your shelves is off the table.

The CSV export is your own data, offered officially. It's also richer than the
API ever was — shelves, dates, ratings, review text and custom shelves in one
file.

## Development

```bash
npm install
cp .env.example .env.local   # add a Hardcover API token
npm run dev
```

A Hardcover token comes from **hardcover.app → account settings → Hardcover
API**. The token is only ever read server-side: in development by the Vite
middleware, in production by the Cloudflare Pages Function. It never reaches the
browser.

## Status

Early, but usable. Reads an export, resolves series, and tells you what to read
next. Not yet deployed publicly — see `TODO.md`.

## Thanks

Series data and cover images from [Hardcover](https://hardcover.app).

## License

MIT
