-- How many requests this deployment has sent to Hardcover, per UTC day.
-- One row a day; nothing here identifies a reader. The Worker also creates
-- this table itself if it is missing, so a deploy never depends on this file
-- having been applied first.
CREATE TABLE IF NOT EXISTS upstream_budget (
  day   TEXT PRIMARY KEY,   -- "2026-10-01"
  calls INTEGER NOT NULL DEFAULT 0
);
