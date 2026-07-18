-- 0435_qr_recommend_mode — how the diner QR menu picks its "เมนูแนะนำ" set.
--   recommend_mode:
--     'manual'           — the per-item menu_items.is_recommended flags (default; unchanged behaviour).
--     'behavior'         — dishes members actually order most (member-attributed dine-in history +
--                          curated member dining-profile favourites) — "ตามพฤติกรรมการกินของลูกค้า".
--     'popular_low_cost' — best sellers weighted by margin (price − cost) — "นิยม + ต้นทุนต่ำ".
--   recommend_count: how many dishes the dynamic modes surface (default 6).
-- Default-valued ⇒ existing rows unchanged; no new tenant table ⇒ no RLS loop.
ALTER TABLE qr_settings ADD COLUMN IF NOT EXISTS recommend_mode text NOT NULL DEFAULT 'manual';
--> statement-breakpoint
ALTER TABLE qr_settings ADD COLUMN IF NOT EXISTS recommend_count integer NOT NULL DEFAULT 6;
