-- ============================================================
-- 048_shop_carts.sql — the product picker's cart, kept on the server.
--
-- One cart per contact: what they've picked in /pedir and not sent yet.
-- Lets a new link open with the same cart, and lets the bot remind the
-- customer ("Dejó 3 productos en su carrito… ¿se los envío?") when they
-- leave without sending. items = [{ "sku": "...", "qty": 2 }, ...].
--
-- Members can read (the CRM may show it); only the server writes.
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS shop_carts (
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  items           jsonb NOT NULL DEFAULT '[]'::jsonb,
  note            text NOT NULL DEFAULT '',
  updated_at      timestamptz NOT NULL DEFAULT now(),
  reminded_at     timestamptz,
  PRIMARY KEY (account_id, contact_id)
);

-- The reminder sweep: carts with something in them, not reminded yet.
CREATE INDEX IF NOT EXISTS shop_carts_due
  ON shop_carts (updated_at)
  WHERE reminded_at IS NULL;

ALTER TABLE shop_carts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shop_carts_select ON shop_carts;
CREATE POLICY shop_carts_select ON shop_carts
  FOR SELECT USING (is_account_member(account_id));
