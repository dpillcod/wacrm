-- ============================================================
-- 039_catalog_fuzzy_search.sql — trigram-based catalog product search
--
-- The AI assistant's catalog lookup (src/lib/ai/catalog.ts) did plain
-- ILIKE substring matching on whitespace-split words. That breaks
-- whenever a customer's phrasing tokenizes differently than the
-- product name — e.g. "Nutrileche" (no space) never matches a
-- product stored as "NUTRI LECHE" (with a space), since neither
-- string is a substring of the other. Trigram similarity compares
-- overlapping 3-character chunks instead of whole-word boundaries,
-- so "nutrileche" and "nutri leche" score highly similar despite the
-- missing space.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Trigram GIN index so similarity search stays fast at catalog scale
-- (accounts here run 30k+ products).
CREATE INDEX IF NOT EXISTS idx_catalog_products_name_trgm
  ON catalog_products USING gin (name gin_trgm_ops);

-- SECURITY INVOKER (default): runs as the calling role, so existing
-- RLS on catalog_products still applies — this function doesn't
-- bypass account isolation.
CREATE OR REPLACE FUNCTION search_catalog_products(
  p_account_id uuid,
  p_query text,
  p_limit int DEFAULT 5
)
RETURNS TABLE (
  retailer_id text,
  name text,
  description text,
  price numeric,
  currency text,
  image_url text
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    cp.retailer_id,
    cp.name,
    cp.description,
    cp.price,
    cp.currency,
    cp.image_url
  FROM catalog_products cp
  WHERE cp.account_id = p_account_id
    AND cp.is_stale = false
    AND (
      cp.name % p_query
      OR cp.name ILIKE '%' || p_query || '%'
      OR similarity(cp.name, p_query) > 0.2
    )
  ORDER BY similarity(cp.name, p_query) DESC
  LIMIT p_limit;
$$;
