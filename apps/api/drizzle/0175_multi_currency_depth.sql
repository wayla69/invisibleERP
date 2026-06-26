-- migration: 0175_multi_currency_depth
-- C1: functional currency on tenants; currency + fx_rate on purchase_orders and goods_receipts.
-- All existing rows keep 'THB' / '1.000000' (current implicit default), so this is backwards-compatible.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS functional_currency text NOT NULL DEFAULT 'THB';

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'THB',
  ADD COLUMN IF NOT EXISTS fx_rate  numeric(14, 6) NOT NULL DEFAULT '1.000000';

ALTER TABLE goods_receipts
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'THB',
  ADD COLUMN IF NOT EXISTS fx_rate  numeric(14, 6) NOT NULL DEFAULT '1.000000';

-- RLS: these are existing tables — the RLS policies on purchase_orders and goods_receipts already
-- cover tenant isolation; functional_currency is on tenants (already RLS-protected).
