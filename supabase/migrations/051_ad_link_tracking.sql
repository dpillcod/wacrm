-- ============================================================
-- 051_ad_link_tracking.sql — scans and customers per advertising link.
--
-- Advertising links (business_settings.adLinks) open WhatsApp with a
-- "#CODE". Partner links — an Airbnb host's QR in their apartment —
-- go first through /r/<account>/<code>, which records the scan here
-- and then opens WhatsApp. When the customer writes with the code,
-- they're remembered in ad_link_contacts: that's what the partner
-- report counts (guests, orders, sales) and what gives the guest the
-- partner discount while the stay lasts.
--
-- Members can read (the CRM shows it); only the server writes.
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS ad_link_scans (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code        text NOT NULL,
  scanned_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ad_link_scans_account_code
  ON ad_link_scans (account_id, code, scanned_at DESC);

CREATE TABLE IF NOT EXISTS ad_link_contacts (
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code           text NOT NULL,
  contact_id     uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- First time the customer wrote with this code; last time they did.
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, code, contact_id)
);

CREATE INDEX IF NOT EXISTS ad_link_contacts_contact
  ON ad_link_contacts (contact_id, last_seen_at DESC);

ALTER TABLE ad_link_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_link_contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ad_link_scans_select ON ad_link_scans;
CREATE POLICY ad_link_scans_select ON ad_link_scans
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS ad_link_contacts_select ON ad_link_contacts;
CREATE POLICY ad_link_contacts_select ON ad_link_contacts
  FOR SELECT USING (is_account_member(account_id));
