-- Phase 9.2 hardening: the `tenants` table has no `tenant_id` column, so the dynamic
-- RLS loop in 0002_rls.sql skipped it — leaving every tenant's credit_limit / tax_id /
-- contact details readable by any scoped user. Add a self-row policy keyed on `id`.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_self_isolation ON tenants;
CREATE POLICY tenant_self_isolation ON tenants
  USING (
    coalesce(current_setting('app.bypass_rls', true), '') = 'on'
    OR id = nullif(current_setting('app.tenant_id', true), '')::bigint
  )
  WITH CHECK (
    coalesce(current_setting('app.bypass_rls', true), '') = 'on'
    OR id = nullif(current_setting('app.tenant_id', true), '')::bigint
  );
