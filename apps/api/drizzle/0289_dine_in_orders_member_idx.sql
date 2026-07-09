-- 0289_dine_in_orders_member_idx — the guest-profile "eats often" aggregation (GuestProfileService.get)
-- filters dine_in_orders by member_id; back it with a tenant-leading index (R1-1 form) so the per-guest
-- order-history scan stays index-backed at scale. Index-only — no new table, no RLS change.
CREATE INDEX IF NOT EXISTS idx_dine_in_orders_tenant_member ON dine_in_orders (tenant_id, member_id);
