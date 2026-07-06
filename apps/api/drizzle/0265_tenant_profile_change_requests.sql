-- 0265 — G15 (maker-checker audit): a change to a tenant's payment-receiving / legal-identity fields is
-- staged for a distinct approver. The PromptPay merchant id (which target RECEIVES customer QR payments)
-- and the Tax ID (legal identity on issued tax invoices) can no longer be changed by a single admin — a
-- change is parked here as PendingApproval and applied to `tenants` only when a DIFFERENT approver releases
-- it (403 SOD_VIOLATION on self-approval). Non-sensitive profile fields (address, phone, branding) still
-- apply immediately. Tenant-scoped (tenant_id is the owning tenant) → RLS re-applied below.
CREATE TABLE IF NOT EXISTS tenant_profile_change_requests (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  req_no text NOT NULL,
  promptpay_id text,                         -- requested new value (null = field not changing)
  tax_id text,
  prev_promptpay_id text,                    -- captured for the audit trail
  prev_tax_id text,
  status text NOT NULL DEFAULT 'PendingApproval', -- PendingApproval | Approved | Rejected
  requested_by text,
  requested_at timestamptz DEFAULT now(),
  approved_by text,                          -- checker — must differ from requester
  approved_at timestamptz,
  reject_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_profile_change_no ON tenant_profile_change_requests (tenant_id, req_no);
CREATE INDEX IF NOT EXISTS idx_tenant_profile_change_status ON tenant_profile_change_requests (tenant_id, status);

-- Re-run the RLS loop so the new tenant_id table is isolation-scoped. GRANT/ENABLE/FORCE structure from
-- 0137, CANONICAL org-clause policy body from 0232 (a plain body here would silently drop cross-account org
-- sharing on every data table, since this migration runs after 0232). Idempotent.
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
