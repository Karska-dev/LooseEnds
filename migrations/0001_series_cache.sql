-- Public bibliographic facts only. Nothing here identifies a reader.
CREATE TABLE IF NOT EXISTS series_cache (
  -- Normalised series name as searched, plus author when we had one.
  cache_key      TEXT PRIMARY KEY,
  -- The full SeriesResult as JSON.
  payload        TEXT NOT NULL,
  -- Epoch milliseconds of the last successful Hardcover fetch.
  fetched_at     INTEGER NOT NULL,
  -- 1 when any volume is unreleased or undated. Those get a one-day TTL
  -- instead of thirty: a date being announced is what readers are waiting
  -- on, but one refresh per series per day is enough to catch it.
  has_unreleased INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS series_cache_fetched_at ON series_cache (fetched_at);
