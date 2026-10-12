-- ============================================================
-- 049_deal_appointments.sql — a date and time on a card: a service
-- visit or the moment a cake / party order is picked up or delivered.
--
--   appointment_at          when it is (the CRM's agenda; copied to Google
--                           Calendar when that's set up)
--   calendar_event_id       the Google Calendar event kept in sync
--   appointment_notified_at when the customer was told the date
--   appointment_reminded_at when the customer got the day-before reminder
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE deals ADD COLUMN IF NOT EXISTS appointment_at timestamptz;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS calendar_event_id text;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS appointment_notified_at timestamptz;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS appointment_reminded_at timestamptz;

CREATE INDEX IF NOT EXISTS deals_appointments
  ON deals (account_id, appointment_at)
  WHERE appointment_at IS NOT NULL;
