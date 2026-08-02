-- ============================================================
-- 038_catalog_sync_cursor.sql — resumable catalog sync
--
-- POST /api/whatsapp/catalog/sync caps how many pages of Meta's
-- catalog it walks per request (large catalogs, like a 33k-product
-- hardware store feed, need dozens of pages). Without remembering
-- where a prior call left off, every subsequent click restarted at
-- page 1 forever. These two columns let the route resume the Graph
-- API pagination across requests and only run stale-marking once
-- the whole catalog has actually been walked end to end.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS catalog_sync_cursor text,
  ADD COLUMN IF NOT EXISTS catalog_sync_started_at timestamptz;
