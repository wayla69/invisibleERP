-- 0434_qr_dynamic_kds_priority — dynamic QR ordering + food-priority KDS.
--   (1) qr_settings.dynamic_mode: when on, a scanned printed QR does NOT self-open a session — it only
--       JOINS a table a staff member has already opened, and stops working the moment the bill closes.
--       Off (default) keeps the legacy self-open behaviour.
--   (2) qr_settings.auto_close_on_paid: when on, a paid table is freed straight to 'available' (skips the
--       'cleaning' hold) so a table can be closed the instant payment clears. Default off (keep cleaning).
--   (3) menu_items.is_recommended: the "เมนูแนะนำ" flag surfaced first on the diner QR menu.
--   (4) menu_items.kds_priority + dine_in_order_items.kds_priority: food-prioritisation for the KDS. The
--       item's priority is SNAPSHOT onto the kitchen line at insert; within one fire "lot" (same fired_at)
--       the higher priority plates out first. Default 0.
-- All columns default-valued ⇒ existing rows unchanged; no new tenant table ⇒ no RLS loop needed.
ALTER TABLE qr_settings ADD COLUMN IF NOT EXISTS dynamic_mode boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE qr_settings ADD COLUMN IF NOT EXISTS auto_close_on_paid boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS is_recommended boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS kds_priority integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE dine_in_order_items ADD COLUMN IF NOT EXISTS kds_priority integer NOT NULL DEFAULT 0;
