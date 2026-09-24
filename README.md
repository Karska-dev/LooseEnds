# Loose Ends

Find the book series you never finished. Drop in your Goodreads export —
it's parsed in your browser, never uploaded.

![The series board: series sorted by what needs your attention, with the next unread volume in each](docs/series-board.png)

## Why

Every reading tracker thinks in books. Almost none think in **series**, which
is how a lot of fiction is actually read. Loose Ends answers one question:
*which series am I part-way through, and what comes next?*

For each series it shows how many you've read, which volume is next, and
whether that volume is out, announced for a future date, or not announced at
all — the last of which is a real answer, not a gap.

## Using it

**Get your export:** on Goodreads, **My Books → Tools → Import and export →
Export Library**.

Desktop browser only; the mobile app has no export. Don't open the file in
Excel first — it mangles ISBNs and dates.

Then drop the file in. There is no account, no sign-up and nothing to install.
Your library is read in the browser and never uploaded; close the tab and it's
gone. The only thing that leaves your machine is a list of series *names* and
their authors, sent to look up which books are in them.

## Why Hardcover

Five other sources were measured against a real 73-series library — Wikidata,
Open Library, Google Books, BookBrainz and LibraryThing. Against the 30 series
that library had read most of, [Hardcover](https://hardcover.app) answered
**30 of 30** and every other source answered **0**.

The reason is in Hardcover's librarian documentation: series membership and
positions are **entered by hand** by volunteers. That data is not imported
from anywhere, which is why no open catalogue has it. For contemporary genre
fiction especially — romantasy, progression fantasy, anything indie — there is
no second source.

Hardcover were asked before this went public, and the answer was specific to
this deployment: a server-side token is fine provided usage stays inside the
API limits, and visitors do not need Hardcover accounts. Anyone forking this
and putting it online should ask them too. Series lookups are cached and shared
between visitors, so a series someone has already looked up costs nothing the
next time, and no Hardcover user's own library is ever read.

## Why there's no "log in with Goodreads"

Goodreads retired its API in December 2020 and issues no new keys. Its terms
prohibit "data mining, robots, or similar data gathering and extraction
tools", so logging in on your behalf and reading your shelves is off the
table.

The CSV export is your own data, offered officially, and it's richer than the
API ever was — shelves, dates, ratings, review text and custom shelves in one
file.

## Status

Early, but working. English editions only. Around 10% of books carry no series
in their Goodreads title; those are listed separately rather than matched, and
a series whose Goodreads name differs from Hardcover's can mis-match.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, architecture and the
gotchas worth knowing before you change anything.

## Thanks

Series data and cover images from [Hardcover](https://hardcover.app) — the
only catalogue that has this data, because their librarians typed it in.
Thank you.

## License

MIT
