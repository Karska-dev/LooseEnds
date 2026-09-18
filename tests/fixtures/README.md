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
