-- 0319 — Leading (tenant_id, …) index on lessor_leases (R1-1 / AUD-ARC-01).
-- FIN-10 (LSE-02) added lessor_leases with a tenant_id column but only a (status, next_run_date) index,
-- so the tenant-idx guard flagged it as an uncovered tenant-scoped table. Add the leading tenant index.
CREATE INDEX IF NOT EXISTS idx_lessor_lease_tenant ON lessor_leases (tenant_id, lease_no);
