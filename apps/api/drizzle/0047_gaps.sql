-- 0047 — Item images (data-URLs in-DB; no object storage). Global, like `items`.
-- (delivery_orders / do_items / gr_claims already exist from 0000 — reused, not recreated.)
CREATE TABLE IF NOT EXISTS item_images (
  item_id text PRIMARY KEY,
  image_key text,
  data_url text,
  updated_at timestamptz DEFAULT now(),
  updated_by text
);
