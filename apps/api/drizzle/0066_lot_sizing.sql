-- Phase D3 — lot-sizing / EOQ inputs on the item master (used by MRP planned-buy lot-sizing).
-- items is a global master (no tenant_id) → no RLS changes needed.
ALTER TABLE items ADD COLUMN IF NOT EXISTS min_order_qty  numeric(14,3) DEFAULT 0;  -- minimum purchase qty
ALTER TABLE items ADD COLUMN IF NOT EXISTS order_multiple numeric(14,3) DEFAULT 0;  -- pack/round-up multiple
ALTER TABLE items ADD COLUMN IF NOT EXISTS order_cost     numeric(14,2) DEFAULT 0;  -- S: cost per purchase order (EOQ)
ALTER TABLE items ADD COLUMN IF NOT EXISTS holding_cost   numeric(14,4) DEFAULT 0;  -- H: holding cost per unit/yr (EOQ)
