-- 0444_pos_lot_capture — lot/expiry capture on the POS sale line (docs/52 Phase 3a).
-- A lot-tracked item (pharmacy/grocery/food) must sell from a real, non-expired, non-held lot. This adds:
--   • items.is_lot_tracked — the shared item master flag (tenant-neutral, no RLS loop, mirrors items.barcode
--     / supply_type; nullable-defaulted so existing items are untracked = byte-identical);
--   • cust_pos_items.lot_no / expiry_date — the lot the sale line consumed (FEFO-picked at sell time), so a
--     sold unit is traceable back to its batch (recall) and forward from the lot ledger.
-- The lot allocation itself is recorded as a qty_out row in the existing lot_ledger (INV-5) by the sale path.
ALTER TABLE items ADD COLUMN IF NOT EXISTS is_lot_tracked boolean NOT NULL DEFAULT false;
ALTER TABLE cust_pos_items ADD COLUMN IF NOT EXISTS lot_no text;
ALTER TABLE cust_pos_items ADD COLUMN IF NOT EXISTS expiry_date date;
