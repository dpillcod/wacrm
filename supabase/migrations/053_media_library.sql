-- ============================================================
-- 053_media_library.sql — finished pieces (images) ready to send.
--
-- A design app (POST /api/v1/media) leaves each approved piece here:
-- the CRM keeps its own copy in the public `media-library` bucket (so
-- Meta can fetch it and it outlives the design app's link) and the
-- inbox composer and the broadcast wizard pick from it instead of
-- downloading and re-uploading the image.
--
-- `ref` is the piece's code in the design app: sending the same ref
-- again replaces the image (a corrected version), never duplicates it.
-- Members can read; only the server writes (API and admin routes).
-- Idempotent — safe to run multiple times.
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'media-library',
  'media-library',
  TRUE,
  5242880, -- 5 MB: Meta's cap for images
  ARRAY['image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS media_library (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Who left it (the API key's name, e.g. "Publikt").
  source        text NOT NULL,
  ref           text,
  name          text NOT NULL,
  -- Suggested text to send with the image (editable before sending).
  caption       text,
  tags          text[] NOT NULL DEFAULT '{}',
  url           text NOT NULL,
  storage_path  text NOT NULL,
  mime_type     text NOT NULL,
  size_bytes    integer NOT NULL,
  -- Last day it makes sense to send it (a campaign's end); NULL = no end.
  valid_until   date,
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS media_library_ref
  ON media_library (account_id, source, ref) WHERE ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS media_library_recent
  ON media_library (account_id, archived_at, updated_at DESC);

ALTER TABLE media_library ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS media_library_select ON media_library;
CREATE POLICY media_library_select ON media_library
  FOR SELECT USING (is_account_member(account_id));
