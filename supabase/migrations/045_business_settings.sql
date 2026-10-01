-- ============================================================
-- 045_business_settings.sql — per-account business settings
--
-- Everything about the business the bot works for — name, city,
-- opening hours, staff alert numbers, blocked products, cross-sell
-- rules, customer-facing texts, order-board messages, … — as ONE JSON
-- document per account, edited in Settings → My business. The app
-- merges it over built-in defaults key by key (see
-- src/lib/business/settings.ts), so a missing row or key is never an
-- error and a new account works before anything is set.
--
-- Members can read (the bot and every panel need it); only admins
-- can change it. The server writes through the service role.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS business_settings (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE business_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS business_settings_select ON business_settings;
CREATE POLICY business_settings_select ON business_settings
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS business_settings_insert ON business_settings;
CREATE POLICY business_settings_insert ON business_settings
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS business_settings_update ON business_settings;
CREATE POLICY business_settings_update ON business_settings
  FOR UPDATE USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS business_settings_delete ON business_settings;
CREATE POLICY business_settings_delete ON business_settings
  FOR DELETE USING (is_account_member(account_id, 'admin'));
