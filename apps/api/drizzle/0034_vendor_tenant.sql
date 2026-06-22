-- Adversarial-verify fix (Phase 16 follow-up): the vendors master had NO tenant_id, so it was a single
-- GLOBAL master shared by every tenant and was NOT RLS-isolated. Phase 16 supplier screening
-- (blocklisted / approval_status on vendors) turned that into a HIGH-severity multi-tenancy hole:
--   • tenant B PATCH /api/procurement/suppliers/:id/status {blocklisted:true} mutates the shared row →
--     tenant A is then denied PO creation for a vendor it never blocklisted (cross-tenant DoS), and
--   • a globally-approved vendor is usable by every tenant with no per-tenant onboarding.
--
-- Ownership decision (see ETL tools/etl/src/etl.ts §9 "vendors"): vendors are loaded from V1
-- suppliers+creditors as a GLOBAL master with NO per-tenant signal, and the PO/GR document chain is not
-- tenant-scoped either — so there is no "owning tenant" to backfill to and fan-out into per-tenant copies
-- is infeasible. We therefore keep the legacy rows as tenant_id IS NULL = "shared master" and isolate via a
-- CUSTOM RLS policy (NOT the standard 0002 tenant_isolation, which makes NULL rows invisible to every
-- tenant and would break existing PO/GR vendor lookups, e.g. costing.ts's non-Admin plan1 user):
--   vendor_tenant_read  (SELECT): bypass OR shared(NULL) OR own  → the shared master stays readable
--   vendor_tenant_write (ALL)   : bypass OR own (USING + CHECK)  → only the owner or HQ/bypass may write
-- Net effect: a non-bypass tenant can no longer mutate a shared vendor (DoS closed), cannot see/mutate
-- another tenant's vendor, and any vendor it creates carries its tenant_id and is fully isolated.

ALTER TABLE vendors ADD COLUMN IF NOT EXISTS tenant_id bigint REFERENCES tenants(id);
CREATE INDEX IF NOT EXISTS idx_vendors_tenant ON vendors (tenant_id);

-- Replace the old global vendor_code unique with a per-tenant one. COALESCE(tenant_id,0) keeps shared (NULL)
-- codes deduped among themselves; the partial WHERE preserves the original nullable-code behaviour
-- (the legacy .unique() on a nullable column allowed many rows with NULL code).
ALTER TABLE vendors DROP CONSTRAINT IF EXISTS vendors_vendor_code_unique;
CREATE UNIQUE INDEX IF NOT EXISTS vendors_tenant_code_uq
  ON vendors (COALESCE(tenant_id, 0), vendor_code)
  WHERE vendor_code IS NOT NULL;

-- Custom tenant isolation for vendors. NB: any FUTURE re-run of the 0002 RLS DO-block will (harmlessly) add a
-- standard `tenant_isolation` policy on vendors now that it carries tenant_id — because policies are OR'd,
-- vendor_tenant_read keeps NULL rows visible and vendor_tenant_write keeps writes owner-only. To avoid the
-- redundant policy entirely, a future loop should exclude vendors (… AND table_name <> 'vendors').
ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendors FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON vendors TO app_user;

DROP POLICY IF EXISTS tenant_isolation ON vendors;
DROP POLICY IF EXISTS vendor_tenant_read ON vendors;
DROP POLICY IF EXISTS vendor_tenant_write ON vendors;

CREATE POLICY vendor_tenant_read ON vendors FOR SELECT
  USING (
    coalesce(current_setting('app.bypass_rls', true), '') = 'on'
    OR tenant_id IS NULL
    OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint
  );

CREATE POLICY vendor_tenant_write ON vendors FOR ALL
  USING (
    coalesce(current_setting('app.bypass_rls', true), '') = 'on'
    OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint
  )
  WITH CHECK (
    coalesce(current_setting('app.bypass_rls', true), '') = 'on'
    OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint
  );
