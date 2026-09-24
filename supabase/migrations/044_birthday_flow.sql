-- ============================================================
-- 044_birthday_flow.sql — birthday message flow trigger
--
-- Lets an account point a daily cron sweep at a dedicated flow, so a
-- contact whose "Fecha de nacimiento" custom field (format MM-DD, no
-- year needed) matches today gets a birthday message automatically.
-- See src/app/api/flows/birthday-cron/route.ts.
--
-- Design notes
--   - Mirrors migration 041's `woocommerce_order_flow_id` column
--     exactly: nullable + ON DELETE SET NULL, so deleting the flow
--     doesn't cascade into whatsapp_config — it just stops the daily
--     sweep from finding a flow to start until reconfigured.
--   - No new table for "which custom field is the birthday field" —
--     the cron looks up `custom_fields.field_name = 'Fecha de
--     nacimiento'` by convention (documented at the call site). A
--     per-account setting for the field name would be more general,
--     but this account only needs the one field name today.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS birthday_flow_id uuid
    REFERENCES flows(id) ON DELETE SET NULL;
