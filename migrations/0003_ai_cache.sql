-- The experimental AI lookup: what it found, and how much of the day's
-- allowance it has used. Public bibliographic facts and a counter; nothing
-- here identifies a reader. The Worker also creates these tables itself if
-- they are missing, so a deploy never depends on this file having been
-- applied first.

-- Kept apart from series_cache on purpose: what a model read off the web is
-- never served as, or mixed with, what Hardcover's librarians entered.
CREATE TABLE IF NOT EXISTS ai_series_cache (
  -- Normalised series name, plus author when we had one (same as series_cache).
  cache_key  TEXT PRIMARY KEY,
  -- The full AiSeriesResult as JSON, including a "not found".
  payload    TEXT NOT NULL,
  -- Epoch milliseconds of the lookup.
  fetched_at INTEGER NOT NULL,
  -- Epoch milliseconds after which it is looked up again: 90 days for a
  -- finished list, 7 when a book is announced or undated, 14 for a miss,
  -- 1 when the search came back about something else.
  expires_at INTEGER NOT NULL,
  -- "ok" or "not_found". Failures are never stored.
  status     TEXT NOT NULL,
  -- Which model read the pages, so a better one can replace its work later.
  model      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ai_series_cache_expires_at ON ai_series_cache (expires_at);

-- Web searches made for the AI lookup, per UTC day. One row a day.
CREATE TABLE IF NOT EXISTS ai_budget (
  day      TEXT PRIMARY KEY,   -- "2026-10-03"
  searches INTEGER NOT NULL DEFAULT 0
);
