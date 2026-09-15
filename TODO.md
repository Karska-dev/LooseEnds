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

## Next build steps

- [ ] Pages Function at `/api/series` — Hardcover primary, Wikidata fallback
- [ ] D1 cache with TTL
- [ ] Series state engine: next unread, published / announced / unannounced
- [ ] Series list and detail screens
