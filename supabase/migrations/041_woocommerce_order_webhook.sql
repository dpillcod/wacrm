-- ============================================================
-- 041_woocommerce_order_webhook.sql — WooCommerce order → flow bridge
--
-- Lets an account point their WooCommerce store's native "Order
-- created" webhook at wacrm, so a web checkout can hand off to a
-- dedicated flow (asks for cédula/RUC on transfer, sends the payment
-- QR, notifies staff) without the customer retyping their order in
-- WhatsApp. See src/app/api/webhooks/woocommerce/[accountId]/route.ts.
--
-- Design notes
--   - `woocommerce_webhook_secret` is plaintext, same treatment as
--     `catalog_id`/`waba_id`/`phone_number_id` (037) — it's a shared
--     secret used to verify WooCommerce's HMAC signature on inbound
--     requests, not a credential that grants access to anything by
--     itself, and only ever compared server-side.
--   - `woocommerce_order_flow_id` points at the flow to start for
--     every incoming order. Nullable + ON DELETE SET NULL: deleting
--     that flow shouldn't silently break unrelated whatsapp_config
--     rows or cascade into deleting config — it just stops routing
--     new orders until reconfigured (the webhook route treats a null
--     flow id as "not configured for this account" and no-ops).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS woocommerce_webhook_secret text,
  ADD COLUMN IF NOT EXISTS woocommerce_order_flow_id uuid
    REFERENCES flows(id) ON DELETE SET NULL;
