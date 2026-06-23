-- 0070 — Buffet behaviour analytics: tag each ordered line with its buffet tier so the menu mix can be
-- grouped by tier. Stamped on buffet food lines (is_buffet) AND the per-pax charge / overtime lines
-- (for per-tier revenue). Column lives on an existing RLS-scoped table, so no RLS loop is needed.
ALTER TABLE dine_in_order_items ADD COLUMN IF NOT EXISTS buffet_package_id bigint REFERENCES buffet_packages(id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_dine_items_buffet_pkg ON dine_in_order_items (buffet_package_id);
