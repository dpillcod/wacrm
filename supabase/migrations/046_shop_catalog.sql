-- ============================================================
-- 046_shop_catalog.sql — the shop's catalog for the customer-facing
-- product picker (/pedir/<token>) and the ERP's sales data.
--
--   shop_products  What the web shop sells (from its product feed, the
--                  same file that feeds the WhatsApp catalog): name,
--                  price with tax, photo, section, category, stock.
--                  Plus sold_90d / erp_stock copied in from the ERP so a
--                  search is one indexed table read, best sellers first.
--   erp_products   What the store system knows (sent from the store PC
--                  with an API key): codes, stock, price, units sold in
--                  the last 90 days. Never costs or suppliers.
--
-- Members can read (the CRM shows them); only the server writes.
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS shop_products (
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  sku         text NOT NULL,
  title       text NOT NULL,
  price       numeric(12,2) NOT NULL,
  sale_price  numeric(12,2),
  image_url   text,
  link        text,
  department  text,
  category    text,
  in_stock    boolean NOT NULL DEFAULT true,
  -- lower-case, accent-free title + sku + section + category
  search_text text NOT NULL DEFAULT '',
  sold_90d    numeric NOT NULL DEFAULT 0,
  erp_stock   numeric,
  synced_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, sku)
);

CREATE INDEX IF NOT EXISTS shop_products_search_trgm
  ON shop_products USING gin (search_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS shop_products_popular
  ON shop_products (account_id, sold_90d DESC);
CREATE INDEX IF NOT EXISTS shop_products_department
  ON shop_products (account_id, department, category);

CREATE TABLE IF NOT EXISTS erp_products (
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code        text NOT NULL,
  barcode     text,
  name        text,
  brand       text,
  class       text,
  stock       numeric,
  price       numeric(12,2),
  sold_90d    numeric NOT NULL DEFAULT 0,
  last_sale   date,
  by_weight   boolean NOT NULL DEFAULT false,
  synced_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, code)
);

CREATE INDEX IF NOT EXISTS erp_products_barcode ON erp_products (account_id, barcode);

ALTER TABLE shop_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shop_products_select ON shop_products;
CREATE POLICY shop_products_select ON shop_products
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS erp_products_select ON erp_products;
CREATE POLICY erp_products_select ON erp_products
  FOR SELECT USING (is_account_member(account_id));

-- Sections and categories (with counts) for the picker's filters, for
-- the words typed so far. Words come lower-case and accent-free.
CREATE OR REPLACE FUNCTION shop_facets(p_account uuid, p_words text[], p_department text)
RETURNS TABLE (kind text, name text, n bigint)
LANGUAGE sql STABLE AS $$
  WITH base AS (
    SELECT sp.department, sp.category
    FROM shop_products sp
    WHERE sp.account_id = p_account
      AND sp.in_stock
      AND (sp.erp_stock IS NULL OR sp.erp_stock > 0)
      AND NOT EXISTS (
        SELECT 1 FROM unnest(coalesce(p_words, '{}'::text[])) w
        WHERE sp.search_text NOT LIKE '%' || w || '%'
      )
  )
  SELECT 'department', department, count(*) FROM base WHERE department IS NOT NULL GROUP BY department
  UNION ALL
  SELECT 'category', category, count(*) FROM base
  WHERE p_department IS NOT NULL AND department = p_department AND category IS NOT NULL
  GROUP BY category;
$$;

-- Copy the ERP's sales and stock onto the shop's products. The web SKU
-- is the ERP barcode or the ERP code (exact match only: "0002357" and
-- "2357" are different products).
CREATE OR REPLACE FUNCTION refresh_shop_popularity(p_account uuid)
RETURNS void LANGUAGE sql AS $$
  UPDATE shop_products sp
  SET sold_90d = coalesce(x.sold, 0), erp_stock = x.stock
  FROM (
    SELECT s.sku,
           coalesce(byc.sold_90d, byb.sold_90d) AS sold,
           coalesce(byc.stock, byb.stock) AS stock
    FROM shop_products s
    LEFT JOIN erp_products byc ON byc.account_id = s.account_id AND byc.code = s.sku
    LEFT JOIN LATERAL (
      SELECT e.sold_90d, e.stock FROM erp_products e
      WHERE e.account_id = s.account_id AND e.barcode = s.sku
      ORDER BY e.sold_90d DESC LIMIT 1
    ) byb ON true
    WHERE s.account_id = p_account
  ) x
  WHERE sp.account_id = p_account AND sp.sku = x.sku
    AND (sp.sold_90d IS DISTINCT FROM coalesce(x.sold, 0) OR sp.erp_stock IS DISTINCT FROM x.stock);
$$;
