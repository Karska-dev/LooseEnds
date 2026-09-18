# Fixtures

Synthetic Goodreads exports, in the real export's column format. Titles,
authors and series are real; ISBNs, ratings, dates and Book Ids are made up.

| File | For |
|---|---|
| `sample.csv` | A small file for checking the parser: Excel-armoured ISBNs, a DNF on a custom shelf, a missing Date Read. |
| `classics.csv` | Manual testing against Hardcover. Every board state appears at least once. |

## What `classics.csv` should produce

Run a lookup against it and expect roughly this:

- **Reading now** — *The Hitchhiker's Guide to the Galaxy*. Book 2 is on the
  reading shelf, so it sorts above everything and the verdict reads
  "you're on #2".
- **Waiting, no date** — *A Song of Ice and Fire*. Five read, the sixth
  unannounced. The case the whole app exists for.
- **Next available** — *Dune* (#3 is out), *Earthsea Cycle* (#2 is out and on
  the to-read shelf, so it should say "already on your list"), *Discworld*
  (#3 of a very long series).
- **A gap** — *Foundation*. Books 1 and 3 are read, 2 is not, so the next book
  is **#2** rather than #4.
- **Finished** — *The Lord of the Rings*. All three read, so it hides behind
  the "finished" checkbox.
- **Set aside** — *The Chronicles of Narnia*. Book 2 is on the `dnf` shelf, so
  the series is dismissed by default and needs the "set aside" checkbox.
- **Not in a series** — Piranesi, Never Let Me Go, The Road, Cloud Atlas,
  Beloved, The Great Gatsby. Six books behind that checkbox.
- **Not listed at all** — *The Expanse*. Only a to-read book, nothing read, so
  it is counted in the line below the list rather than shown as a loose end.

Two things that should appear in a volume list but never as "next":

- The **omnibus** at `(The Lord of the Rings, #1-3)`.
- The **half-numbered** *The Daughter of Odren* at `(Earthsea Cycle, #6.5)`.

Four of the six books with no series also have no Date Read, so the date
coverage figure should be visibly below 100%.

## Deliberately broken exports

For manual testing of failure paths. Drop each into the app and check the
message is one a reader can act on. None of them crash — that was verified by
running every file through the real parser.

| File | What it is | What the app does |
|---|---|---|
| `bad-empty.csv` | zero bytes | "That file is empty. Try exporting it again from Goodreads." |
| `bad-not-a-csv.csv` | a saved HTML error page | 0 books → "That file has no book rows. Is it the Goodreads library export?" |
| `bad-wrong-columns.csv` | valid CSV, different schema | same: 0 books, same message |
| `bad-header-only.csv` | correct header, no rows | same: 0 books, same message |
| `bad-malformed.csv` | unclosed quote, ragged rows | 4 books parsed, 1 series found; the broken rows land as unmatched rather than failing the file |
| `bad-edge-cases.csv` | valid CSV, hostile content | 19 books of 21 rows, 11 series — the two title-less rows are dropped |

### What `bad-edge-cases.csv` covers

Each row tests one thing. Confirmed behaviour:

- **Dropped entirely** — a row with no title, and one whose title is only
  whitespace.
- **Not treated as a series** — `(Vintage International)` with no `#` is an
  imprint; `#-1` is not a position; `( , #1)` has no name; and
  `(Nested (Parens) Series, #1)` is skipped because the pattern deliberately
  refuses inner parentheses.
- **Accepted, and should be** — `#0` (box sets), `#1.2345`, `#999999999`, a
  600-character title, emoji in the series name (stripped from the grouping
  key, kept in the display name), and a title starting with `=`, which is a
  spreadsheet formula but only ever text here.
- **Duplicate rows** — the same book twice appears twice in the volume list,
  deduplicated per position by shelf rank.

### Known quirk this file exposes

An **unrecognised exclusive shelf becomes `to_read`**. Goodreads only has
three, but the column can hold anything, and `toShelf()` falls through to
`to_read` for anything that is not `read` or `currently-reading`. Rows 16 and
17 test this: a shelf named `abandoned-forever` and an empty one both count as
to-read. Nothing breaks, but those books are silently misfiled rather than
reported.

### Too large to commit

The 20 MB size guard needs a file nobody wants in git. Generate one:

```bash
{ head -1 tests/fixtures/classics.csv
  for i in $(seq 200000); do tail -n +2 tests/fixtures/classics.csv | head -1; done
} > /tmp/huge.csv
```

Expect: "That file is NN MB, which is far larger than any Goodreads export."
