# TODO

## Blocking before the site goes public

- [ ] **Message Hardcover about API terms.**
      Their docs say the API is *"only for offline use at this time. You can only
      access this API from localhost or APIs"* and that *"you can't use the API to
      access and use someone else's data"*. A private instance is clearly fine; a
      public deployment is what that clause excludes.
      Ask via their Discord or support. Points to make:
      - free, non-commercial, open source
      - no user accounts; visitors' libraries are parsed in the browser and never stored
      - queries only public series metadata — never any Hardcover user's data
      - happy to add attribution and link back to Hardcover
      Build and test locally in the meantime. Do not share the public URL until they answer.

- [ ] **Restrict the Google Books API key** by HTTP referrer in Google Cloud Console
      (localhost + the pages.dev domain), or regenerate it. It has been exposed in chat.

- [ ] **Rotate the Hardcover token** before launch, for the same reason.

- [ ] **Rotate the LibraryThing key** — also exposed in chat. Read-only, low
      stakes, but it costs nothing to replace.

## Deferred

- [ ] **Multi-language editions.** v0.1 shows English only (`language_id: 1`),
      falling back to the most-read edition when no English one exists. The API
      already returns every language per position, and `SeriesEntry.cleanTitle`
      is kept for this: match the reader's own titles against the editions to
      infer which language they read, then use it for the whole series. Decide
      language once per series, never per position, or a list comes back mixed.

## Before sharing the link

- [ ] Serve sized cover images rather than full-resolution ones scaled to 36px

## Open design question

- **Should a book in progress mid-series outrank one merely available?**
  A reader part-way through book 2 of 5 currently gets `next_available`,
  the same rank as a series untouched for a year, because `reading` is only
  reported when nothing remains after the book in hand. Pinned by a test in
  `tests/sort.test.ts` so the current behaviour is deliberate rather than
  accidental. A product call, not a bug.

## Closed questions

- **Can another source reduce Hardcover usage?** No. Measured with
  `npm run probe` against 30 real series: Hardcover 30/30, Wikidata 0/30,
  Open Library 0/30, Google Books 0/30, BookBrainz 0/30, LibraryThing 0/30.
  There is no fallback to build. Usage is instead controlled by the D1 cache,
  which costs about 28 upstream requests a day for a whole library.
  Re-run the probe if that ever seems worth revisiting.

## Known matching weaknesses

- **Superset series.** Searching "Mistborn" returns both "The Mistborn Saga"
  and "The Cosmere", which contains it and is larger and more read. Name
  similarity now decides, but a series whose name genuinely differs from the
  Goodreads string will still mis-hit. The manual override table in v0.2 is
  the real answer.
- **Aggregate entries.** Hardcover has user-created series that lump an
  author's whole output together. Nothing distinguishes them from a real
  series except size and name.
