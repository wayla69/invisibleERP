-- 0193 — Hybrid tenancy: org-scoped Admin RLS bypass (panel Round-2, condition #1).
-- Adds an "org" grouping so an Admin can be scoped to its own HQ's tenants instead of seeing ALL
-- tenants. Backward-compatible: org_id defaults NULL and the new policy clause is INERT unless the
-- request sets app.org_id (only TENANCY_MODE=multi-company does). Single-company deploys keep the
-- existing global-bypass fast path (app.bypass_rls='on') with ZERO behavior change.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS org_id bigint;
ALTER TABLE users   ADD COLUMN IF NOT EXISTS org_id bigint;
CREATE INDEX IF NOT EXISTS tenants_org_id_idx ON tenants (org_id);
CREATE INDEX IF NOT EXISTS users_org_id_idx   ON users (org_id);

-- API-key expiry (panel #1, minor) — a key past expires_at is treated as revoked. NULL = non-expiring.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- Re-create the tenant_isolation policy on EVERY tenant_id table with an added org clause.
-- The org subquery depends only on the GUC (not the row) → Postgres evaluates it once per query
-- (InitPlan), so the per-row cost is unchanged. Mirrors the generator in 0002_rls.sql.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'tenant_id'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I'
      || ' USING (coalesce(current_setting(''app.bypass_rls'', true), '''') = ''on'''
      || '        OR tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint'
      || '        OR (nullif(current_setting(''app.org_id'', true), '''') IS NOT NULL'
      || '            AND tenant_id IN (SELECT id FROM tenants WHERE org_id = nullif(current_setting(''app.org_id'', true), '''')::bigint)))'
      || ' WITH CHECK (coalesce(current_setting(''app.bypass_rls'', true), '''') = ''on'''
      || '        OR tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint'
      || '        OR (nullif(current_setting(''app.org_id'', true), '''') IS NOT NULL'
      || '            AND tenant_id IN (SELECT id FROM tenants WHERE org_id = nullif(current_setting(''app.org_id'', true), '''')::bigint)))',
      r.table_name);
  END LOOP;
END $$;

-- The tenants table keys on `id` (no tenant_id) → update its self-policy (from 0003) to also let an
-- org-scoped Admin read sibling tenants in the same org.
DROP POLICY IF EXISTS tenant_self_isolation ON tenants;
CREATE POLICY tenant_self_isolation ON tenants
  USING (
    coalesce(current_setting('app.bypass_rls', true), '') = 'on'
    OR id = nullif(current_setting('app.tenant_id', true), '')::bigint
    OR (nullif(current_setting('app.org_id', true), '') IS NOT NULL
        AND org_id = nullif(current_setting('app.org_id', true), '')::bigint)
  )
  WITH CHECK (
    coalesce(current_setting('app.bypass_rls', true), '') = 'on'
    OR id = nullif(current_setting('app.tenant_id', true), '')::bigint
    OR (nullif(current_setting('app.org_id', true), '') IS NOT NULL
        AND org_id = nullif(current_setting('app.org_id', true), '')::bigint)
  );
