-- 0270_vendor_bank_change_requests — master-data audit fix: a vendor's bank_name/bank_account change had
-- NO dual control (unlike the company's own bank_accounts, 0264, and the tenant PromptPay/tax-id G15
-- pattern). Stages a change as PendingApproval; applied only when a DISTINCT approver releases it — the
-- classic Business-Email-Compromise / vendor-payment-fraud vector this closes. Also adds a basic creation
-- audit trail to vendors itself (it had none). vendor_bank_change_requests carries its own tenant_id (nullable,
-- mirrors vendors.tenant_id) so the generic RLS loop below scopes it correctly.
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS created_by text;
--> statement-breakpoint
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS vendor_bank_change_requests (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  vendor_id bigint NOT NULL REFERENCES vendors(id),
  req_no text NOT NULL,
  bank_name text,
  bank_account text,
  prev_bank_name text,
  prev_bank_account text,
  status text NOT NULL DEFAULT 'PendingApproval',
  requested_by text,
  requested_at timestamptz DEFAULT now(),
  approved_by text,
  approved_at timestamptz,
  reject_reason text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_bank_change_no ON vendor_bank_change_requests (vendor_id, req_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_vendor_bank_change_status ON vendor_bank_change_requests (vendor_id, status);
--> statement-breakpoint
-- Tenant-leading index (docs/27 R1-1/AUD-ARC-01) — every tenant-scoped table needs one; the natural
-- uniqueness/status lookups above are vendor-scoped, so this is added separately.
CREATE INDEX IF NOT EXISTS idx_vendor_bank_change_tenant ON vendor_bank_change_requests (tenant_id);
--> statement-breakpoint
-- Re-run the RLS loop so vendor_bank_change_requests (a new tenant_id table) is isolation-scoped. GRANT/
-- ENABLE/FORCE structure from 0137, CANONICAL org-clause policy body from 0232 (a plain body here would
-- silently drop cross-account org sharing on every data table). Idempotent.
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
