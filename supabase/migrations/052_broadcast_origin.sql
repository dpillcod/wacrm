-- ============================================================
-- 052_broadcast_origin.sql — broadcast drafts left by another app.
--
-- A marketing app (scope broadcasts:draft) can leave a broadcast as a
-- draft: template, header image, variable values and a suggested
-- audience. A person opens it in Broadcasts, reviews it and sends it —
-- the same row then moves draft → sending → sent, so the app can read
-- the result back.
--
-- origin = { source, ref, note, text, headerMediaUrl, suggestedTags }
-- (null for broadcasts made in the CRM).
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS origin jsonb;
