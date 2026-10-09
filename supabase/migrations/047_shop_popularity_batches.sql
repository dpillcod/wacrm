-- ============================================================
-- 047_shop_popularity_batches.sql — copy the ERP's sales and stock
-- onto the shop's products a slice at a time.
--
-- refresh_shop_popularity (046) updated every product in one statement;
-- with ~36k products (each update also touches the search index) it
-- ran past the API's statement timeout and nothing was saved. This one
-- updates at most p_limit products whose values changed and returns how
-- many it updated: the server calls it again until it returns 0.
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION refresh_shop_popularity_batch(p_account uuid, p_limit integer DEFAULT 2000)
RETURNS integer LANGUAGE sql AS $$
  WITH by_barcode AS (
    SELECT DISTINCT ON (e.barcode) e.barcode, e.sold_90d, e.stock
    FROM erp_products e
    WHERE e.account_id = p_account AND e.barcode IS NOT NULL
    ORDER BY e.barcode, e.sold_90d DESC
  ),
  x AS (
    SELECT s.sku,
           coalesce(c.sold_90d, b.sold_90d, 0) AS sold,
           coalesce(c.stock, b.stock) AS stock
    FROM shop_products s
    LEFT JOIN erp_products c ON c.account_id = p_account AND c.code = s.sku
    LEFT JOIN by_barcode b ON b.barcode = s.sku
    WHERE s.account_id = p_account
      AND (s.sold_90d IS DISTINCT FROM coalesce(c.sold_90d, b.sold_90d, 0)
           OR s.erp_stock IS DISTINCT FROM coalesce(c.stock, b.stock))
    LIMIT greatest(1, least(p_limit, 10000))
  ),
  upd AS (
    UPDATE shop_products sp
    SET sold_90d = x.sold, erp_stock = x.stock
    FROM x
    WHERE sp.account_id = p_account AND sp.sku = x.sku
    RETURNING 1
  )
  SELECT count(*)::integer FROM upd;
$$;
