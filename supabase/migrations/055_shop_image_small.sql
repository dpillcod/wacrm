-- Small product photo for the catalog page (/pedir): the shop's feed
-- may carry an `image_small` column (a ~300 px copy, a few KB) next to
-- image_link. The grid and the list use it; the full photo opens on tap.
ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS image_small text;
