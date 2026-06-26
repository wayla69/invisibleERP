-- 0138 — WMS storage layout: give each bin a physical position + size so the warehouse can be drawn as a
-- 2D floor plan / 3D model and stock can be located spatially. pos_x/pos_y/pos_z place the bin on the floor
-- (pos_x = aisle axis, pos_y = depth, pos_z = level/height); dim_w/dim_d/dim_h are its footprint/height for
-- rendering. capacity already exists on bins (max units) — the layout colours each bin by utilisation
-- (on-hand ÷ capacity) and putaway now enforces it (INV-08: a bin cannot be filled beyond capacity).
ALTER TABLE bins ADD COLUMN IF NOT EXISTS pos_x numeric(10,2) NOT NULL DEFAULT 0;
ALTER TABLE bins ADD COLUMN IF NOT EXISTS pos_y numeric(10,2) NOT NULL DEFAULT 0;
ALTER TABLE bins ADD COLUMN IF NOT EXISTS pos_z numeric(10,2) NOT NULL DEFAULT 0;
ALTER TABLE bins ADD COLUMN IF NOT EXISTS dim_w numeric(10,2) NOT NULL DEFAULT 1;
ALTER TABLE bins ADD COLUMN IF NOT EXISTS dim_d numeric(10,2) NOT NULL DEFAULT 1;
ALTER TABLE bins ADD COLUMN IF NOT EXISTS dim_h numeric(10,2) NOT NULL DEFAULT 1;

-- No new tenant_id table → the RLS loop need not be re-run (bins is already isolation-scoped).
