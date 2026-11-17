-- ============================================================
-- 054: formal quotes on cards, ad clicks for Meta's Conversions API,
--      and the Google review request after delivery
--
--   deals.quote              — the quote staff prepared on the card
--                              (rows, delivery, validity, status); the
--                              PDF is rebuilt from it. See
--                              src/lib/pipelines/quote.ts.
--   deals.conversion_sent_at — when the sale was reported to Meta
--                              (Conversions API), so it's sent once.
--   contacts.ad_click_id     — the ctwa_clid Meta attaches to the first
--                              message after a Click-to-WhatsApp ad;
--   contacts.ad_click_at       Meta matches the sale to the ad with it.
-- ============================================================

ALTER TABLE deals ADD COLUMN IF NOT EXISTS quote JSONB;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS conversion_sent_at TIMESTAMPTZ;

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ad_click_id TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ad_click_at TIMESTAMPTZ;

-- Google review request after delivery (lib/pipelines/review-request.ts):
--   deals.delivered_at          — when the card first reached "Entregado";
--   deals.review_request_status — 'sent' | 'skipped' (asked in the last
--                                 90 days, window closed…) once handled;
--   deals.review_requested_at   — when it was handled.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS review_request_status TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS review_requested_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_deals_review_pending
  ON deals (delivered_at) WHERE delivered_at IS NOT NULL AND review_request_status IS NULL;
