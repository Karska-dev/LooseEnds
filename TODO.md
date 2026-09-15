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

## Deferred

- [ ] **Multi-language editions.** v0.1 shows English only (`language_id: 1`),
      falling back to the most-read edition when no English one exists. The API
      already returns every language per position, and `SeriesEntry.cleanTitle`
      is kept for this: match the reader's own titles against the editions to
      infer which language they read, then use it for the whole series. Decide
      language once per series, never per position, or a list comes back mixed.

## Next build steps

- [ ] Pages Function at `/api/series` — Hardcover primary, Wikidata fallback
- [ ] D1 cache with TTL
- [ ] Series state engine: next unread, published / announced / unannounced
- [ ] Series list and detail screens

## Remove before sharing

- [ ] **Delete the `/api/health` diagnostic** in `worker/index.ts`. It lists
      binding names and the token's length and 7-character prefix. Harmless
      while the site is private, but it should not exist on a public URL.

## Known matching weaknesses

- **Superset series.** Searching "Mistborn" returns both "The Mistborn Saga"
  and "The Cosmere", which contains it and is larger and more read. Name
  similarity now decides, but a series whose name genuinely differs from the
  Goodreads string will still mis-hit. The manual override table in v0.2 is
  the real answer.
- **Aggregate entries.** Hardcover has user-created series that lump an
  author's whole output together. Nothing distinguishes them from a real
  series except size and name.
