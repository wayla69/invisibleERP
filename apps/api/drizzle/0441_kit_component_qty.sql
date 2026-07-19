-- 0441_kit_component_qty — kits/bundles component quantity (docs/52 Phase 2c).
-- A kit/bundle parent item sells as ONE sale line at ONE price, but on sale its COMPONENT stock (and COGS)
-- is decremented — the kit SKU itself holds no stock. Components are modelled as existing directional
-- item_relationships rows (rel_type='kit_component', from=kit → to=component); this adds the per-component
-- QUANTITY (how many of the component are consumed per kit sold). Existing rows default to 1 (a plain
-- one-for-one relationship / advisory substitute/complement rows are unaffected). item_relationships is
-- TENANT-SCOPED and already RLS-enabled + app_user-granted (0276), so a plain nullable/defaulted column
-- needs no RLS loop and no new grant.
ALTER TABLE item_relationships ADD COLUMN IF NOT EXISTS qty numeric(14,3) NOT NULL DEFAULT 1;
