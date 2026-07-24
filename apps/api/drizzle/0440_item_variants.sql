-- 0440_item_variants — product variants / matrix items (docs/52 Phase 2b).
-- A matrix PARENT item (is_matrix_parent) owns child variant rows: each variant is a real `items` row with
-- its own item_id / barcode / unit_price / stock, linked to the parent via parent_item_id (→ items.id).
-- `items` is a SHARED master (no tenant_id), so these columns + the attributes table are tenant-neutral —
-- no RLS loop, mirroring items.barcode (0250) and the lifecycle columns. Nullable/defaulted ⇒ existing
-- items are unaffected (parent_item_id NULL = a plain item).
ALTER TABLE items ADD COLUMN IF NOT EXISTS parent_item_id bigint;
ALTER TABLE items ADD COLUMN IF NOT EXISTS is_matrix_parent boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_items_parent ON items (parent_item_id) WHERE parent_item_id IS NOT NULL;

-- The variant's attribute values (Size=M, Color=Red). One row per (variant item, axis). Shared master.
CREATE TABLE IF NOT EXISTS item_variant_attributes (
  id      BIGSERIAL PRIMARY KEY,
  item_id TEXT NOT NULL,
  axis    TEXT NOT NULL,
  value   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_item_variant_attrs_item ON item_variant_attributes (item_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_item_variant_attr ON item_variant_attributes (item_id, axis);

-- Grant the non-superuser app role (prod runs as ierp_app) — mirror 0234/0247. Shared master, no RLS.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON item_variant_attributes TO app_user;
    GRANT USAGE, SELECT ON SEQUENCE item_variant_attributes_id_seq TO app_user;
  END IF;
END $$;
