-- ============================================================
-- 040_conversation_cart.sql — per-conversation order cart
--
-- Lets the AI assistant track "what the customer is ordering" across
-- a WhatsApp conversation instead of re-guessing it each turn. The
-- model signals intent via sentinels (parsed in src/lib/ai/generate.ts):
--   [[CART_ADD:<retailer_id>:<qty>]] — add/update a line item
--   [[CART_TOTAL]]                   — customer asked for their total
--
-- Prices are NEVER trusted from the model — every line item's price
-- is copied from `catalog_products` at the moment it's added (the
-- same "validate before trusting" rule as the existing product-
-- recommendation sentinel), and the total customers see is always
-- computed by our own code, never asserted by the LLM.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS conversation_cart_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  retailer_id     text NOT NULL,
  name            text NOT NULL,
  price           numeric,
  currency        text,
  quantity        integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One line per product per conversation — re-adding the same item
-- updates the quantity instead of duplicating the row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_items_conv_retailer
  ON conversation_cart_items(conversation_id, retailer_id);

CREATE INDEX IF NOT EXISTS idx_cart_items_conversation
  ON conversation_cart_items(conversation_id);

ALTER TABLE conversation_cart_items ENABLE ROW LEVEL SECURITY;

-- RLS mirrors catalog_products (037): any account member can read,
-- agent+ can write — cart edits happen as a byproduct of normal
-- inbox/AI activity, not an account-level setting change.
DROP POLICY IF EXISTS conversation_cart_items_select ON conversation_cart_items;
CREATE POLICY conversation_cart_items_select ON conversation_cart_items
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS conversation_cart_items_insert ON conversation_cart_items;
CREATE POLICY conversation_cart_items_insert ON conversation_cart_items
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS conversation_cart_items_update ON conversation_cart_items;
CREATE POLICY conversation_cart_items_update ON conversation_cart_items
  FOR UPDATE USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS conversation_cart_items_delete ON conversation_cart_items;
CREATE POLICY conversation_cart_items_delete ON conversation_cart_items
  FOR DELETE USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_conversation_cart_items_updated_at ON conversation_cart_items;
CREATE TRIGGER set_conversation_cart_items_updated_at
  BEFORE UPDATE ON conversation_cart_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
