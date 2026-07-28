-- ============================================================
-- 037_whatsapp_catalog.sql — WhatsApp Business Catalog products
--
-- Lets an account connect a Meta Commerce Manager catalog (the same
-- one attached to their WhatsApp Business number) and send native
-- product/product-list interactive messages built from it — either
-- manually from the inbox or auto-suggested by the AI reply
-- assistant (see `ai_configs.product_suggestions_enabled` below).
--
-- Design notes
--   - `whatsapp_config.catalog_id` is plaintext, same treatment as
--     `waba_id` / `phone_number_id` — a Commerce catalog id is not a
--     secret by itself (the WABA access token already gates it).
--   - `catalog_products` caches what `POST /api/whatsapp/catalog/sync`
--     pulls from Meta's Graph API, exactly like `message_templates`
--     caches synced WhatsApp templates. Rows are never hard-deleted on
--     sync — a product removed from the catalog is marked `is_stale`
--     so an in-flight message still referencing it doesn't break;
--     stale rows are excluded from the picker/AI candidates.
--   - RLS mirrors `quick_replies` (035): any account member can read
--     (the inbox picker needs it), `agent`+ can write (same tier as
--     sending messages — not admin-locked, since syncing is a routine
--     operational action, not an account-level setting change).
--   - `ai_configs.product_suggestions_enabled` is a separate opt-in
--     from `is_active`/`auto_reply_enabled` — an account can run the
--     AI assistant without ever recommending products, and the
--     settings UI keeps this toggle disabled until a catalog_id is
--     configured.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS catalog_id text;

CREATE TABLE IF NOT EXISTS catalog_products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  retailer_id     text NOT NULL,        -- Meta's product_retailer_id (SKU)
  meta_product_id text,                 -- Meta's internal catalog product id
  name            text NOT NULL,
  description     text,
  price           numeric,
  currency        text,
  availability    text,                 -- 'in stock' | 'out of stock' | ...
  image_url       text,
  is_stale        boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS catalog_products_account_retailer_key
  ON catalog_products(account_id, retailer_id);

CREATE INDEX IF NOT EXISTS idx_catalog_products_account
  ON catalog_products(account_id);

ALTER TABLE catalog_products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS catalog_products_select ON catalog_products;
CREATE POLICY catalog_products_select ON catalog_products FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS catalog_products_insert ON catalog_products;
CREATE POLICY catalog_products_insert ON catalog_products FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS catalog_products_update ON catalog_products;
CREATE POLICY catalog_products_update ON catalog_products FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS catalog_products_delete ON catalog_products;
CREATE POLICY catalog_products_delete ON catalog_products FOR DELETE
  USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON catalog_products;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON catalog_products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- AI product-recommendation opt-in.
-- ============================================================
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS product_suggestions_enabled boolean NOT NULL DEFAULT false;
