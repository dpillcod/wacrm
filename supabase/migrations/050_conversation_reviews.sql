-- ============================================================
-- 050_conversation_reviews.sql — automatic quality review of each
-- customer conversation.
--
-- When a customer stops writing for a while, an AI reads that session
-- (customer, bot and team messages) and notes what went wrong: a
-- question left unanswered, a product lost from the list, a customer
-- who got confused or left. One row per conversation session; the
-- admins get a notification when something went wrong.
--
-- Members can read (the CRM may show it); only the server writes.
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS conversation_reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  -- First and last message of the session reviewed.
  session_start   timestamptz NOT NULL,
  session_end     timestamptz NOT NULL,
  verdict         text NOT NULL CHECK (verdict IN ('bien', 'regular', 'mal')),
  -- [{ "gravedad": "alta"|"media"|"baja", "mensaje_cliente": "...", "que_paso": "...", "sugerencia": "..." }]
  problems        jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary         text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, session_start)
);

CREATE INDEX IF NOT EXISTS conversation_reviews_account_created
  ON conversation_reviews (account_id, created_at DESC);

ALTER TABLE conversation_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversation_reviews_select ON conversation_reviews;
CREATE POLICY conversation_reviews_select ON conversation_reviews
  FOR SELECT USING (is_account_member(account_id));
