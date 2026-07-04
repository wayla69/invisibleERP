-- 0244_location_posting_accounts — Warehouse account defaults (docs/33 PR5, GL-21). Adds the lowest tier of
-- item-posting account determination: a per-warehouse default inventory / adjustment account. Resolution
-- precedence becomes item → its category → THIS warehouse → the hardcoded control literal (1200 / 5810).
-- Nullable, so no effect unless set AND the tenant has opted into posting_determination. locations is a
-- GLOBAL master (no tenant_id) so these are tenant-neutral defaults, same as the item-level columns (0243).
ALTER TABLE locations ADD COLUMN IF NOT EXISTS inventory_account text;
--> statement-breakpoint
ALTER TABLE locations ADD COLUMN IF NOT EXISTS adjustment_account text;
