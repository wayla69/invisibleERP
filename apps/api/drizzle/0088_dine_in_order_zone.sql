-- 0088 — snapshot the room on a settled dine-in order so per-room revenue is historically accurate:
-- a table can be moved to another room later, but the sale must stay with the room it was sold in
-- (zone lives on the table, not on the historical sale). Nullable analytics tag on the existing RLS
-- table dine_in_orders. Backfill existing orders from their table's current room for report continuity.
ALTER TABLE dine_in_orders ADD COLUMN IF NOT EXISTS zone_id bigint;
--> statement-breakpoint
UPDATE dine_in_orders o SET zone_id = t.zone_id FROM dining_tables t WHERE o.table_id = t.id AND o.zone_id IS NULL;
