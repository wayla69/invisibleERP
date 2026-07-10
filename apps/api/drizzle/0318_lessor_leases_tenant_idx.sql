-- 0318: lessor_leases missing the tenant-leading index (cutover/tenant-idx gate, R1-1 / AUD-ARC-01).
-- 0309 created the FIN-10 lessor table with tenant_id but only (status, next_run_date) — every
-- tenant-scoped table must carry a leading (tenant_id, …) index so per-tenant scans don't degrade
-- to full-table under RLS. Same pattern as 0316 (idx_<table>_tenant).
CREATE INDEX IF NOT EXISTS idx_lessor_leases_tenant ON lessor_leases (tenant_id, status);
