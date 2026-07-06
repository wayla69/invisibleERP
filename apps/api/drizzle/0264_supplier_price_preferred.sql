-- 0264_supplier_price_preferred — "ผู้ขายประจำ" (preferred supplier per item) on the versioned supplier
-- price list. A buyer marks one vendor as the default source for an item; the PR→PO screen then auto-groups
-- each requisition line to its preferred vendor (falling back to cheapest active price, then last PO vendor)
-- so one PR fans out into one PO per supplier. supplier_price_lists is already tenant-scoped (RLS via the
-- generic loop) so a plain column-add needs no RLS clause. The partial unique index enforces at-most-one
-- preferred ACTIVE row per (tenant,item) — a hard integrity backstop to the app's unset-siblings logic.
ALTER TABLE supplier_price_lists ADD COLUMN IF NOT EXISTS preferred boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_spl_preferred_per_item
  ON supplier_price_lists (tenant_id, item_id)
  WHERE preferred AND status = 'active';
