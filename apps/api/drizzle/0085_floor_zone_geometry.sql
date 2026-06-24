-- 0085 — Floor-plan zones/rooms get geometry + an accent colour so the editor can draw each zone as a
-- positioned "room" on the plan (e.g. a VIP room) instead of one flat canvas. All columns have defaults
-- → existing zones are unchanged. Columns on the existing RLS table floor_zones (no new table → no RLS loop).
ALTER TABLE floor_zones ADD COLUMN IF NOT EXISTS pos_x numeric(8,2) DEFAULT '16';
--> statement-breakpoint
ALTER TABLE floor_zones ADD COLUMN IF NOT EXISTS pos_y numeric(8,2) DEFAULT '16';
--> statement-breakpoint
ALTER TABLE floor_zones ADD COLUMN IF NOT EXISTS width numeric(8,2) DEFAULT '320';
--> statement-breakpoint
ALTER TABLE floor_zones ADD COLUMN IF NOT EXISTS height numeric(8,2) DEFAULT '200';
--> statement-breakpoint
ALTER TABLE floor_zones ADD COLUMN IF NOT EXISTS color text;
