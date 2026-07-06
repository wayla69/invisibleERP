-- ITGC-AC-09 (maker-checker audit gap G11): two-person control over a Segregation-of-Duties EXCEPTION.
-- A permission/role grant whose set holds both sides of an SoD rule can no longer be self-authorized by the
-- granting admin with a free-text reason — it is STAGED here as a PendingApproval request and only takes
-- effect when a DIFFERENT admin (≠ requester and ≠ the affected user) approves it. For a new user the
-- password hash is held until approval (mirrors signup_requests). Tenant-scoped; RLS re-applied below.
CREATE TABLE IF NOT EXISTS access_grant_exceptions (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  req_no text NOT NULL,
  target_username text NOT NULL,
  is_new_user text NOT NULL DEFAULT 'false',
  password_hash text,
  role text,
  permissions text,
  customer_name text,
  sod_rules text,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'PendingApproval',
  requested_by text,
  requested_at timestamptz DEFAULT now(),
  approved_by text,
  approved_at timestamptz,
  reject_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_access_grant_exc_no ON access_grant_exceptions (tenant_id, req_no);
CREATE INDEX IF NOT EXISTS idx_access_grant_exc_status ON access_grant_exceptions (tenant_id, status);

-- Re-run the RLS loop so the new tenant_id table is isolation-scoped. GRANT/ENABLE/FORCE structure from
-- 0137, but the CANONICAL org-clause policy body from 0232 (a plain body here would silently drop
-- cross-account org sharing on every data table, since this migration runs after 0232). Idempotent.
DO $$
DECLARE r record;
BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'tenant_id'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
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
