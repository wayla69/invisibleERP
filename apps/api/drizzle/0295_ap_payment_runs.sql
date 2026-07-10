-- 0295_ap_payment_runs — AP payment run + Thai bank payment file (FIN-2, control EXP-13).
-- ap_payment_runs: a BATCH disbursement proposal (open approved AP selected by due-date cutoff) with a
-- maker-checker lifecycle (Draft → PendingApproval → Approved → Executed; Rejected/Cancelled), the source
-- house-bank for the bulk-transfer file, run totals, and the SHA-256 of the last generated bank file
-- (audit evidence). ap_payment_run_lines: one AP bill per line with the amount to pay, the WHT summary
-- (resolved with the same tax-code logic as a manual payment; authoritative amount recomputed at execution
-- by the existing approveApPayment), the APP-/PAY-AP references minted at execution, and the bank-statement
-- clearing flag. Tenant-scoped (RLS + tenant-leading indexes).
CREATE TABLE IF NOT EXISTS ap_payment_runs (
  id bigserial PRIMARY KEY,
  run_no text NOT NULL UNIQUE,
  tenant_id bigint REFERENCES tenants(id),
  status text NOT NULL DEFAULT 'Draft',
  pay_date date,
  due_cutoff date,
  bank_account_id bigint,
  total_amount numeric(14,2) DEFAULT 0,
  total_wht numeric(14,2) DEFAULT 0,
  total_net numeric(14,2) DEFAULT 0,
  line_count integer DEFAULT 0,
  created_by text,
  created_at timestamptz DEFAULT now(),
  submitted_at timestamptz,
  approved_by text,
  approved_at timestamptz,
  reject_reason text,
  executed_by text,
  executed_at timestamptz,
  file_format text,
  file_hash text,
  file_generated_at timestamptz,
  remarks text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ap_payment_runs_status ON ap_payment_runs (tenant_id, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ap_payment_run_lines (
  id bigserial PRIMARY KEY,
  run_id bigint NOT NULL,
  tenant_id bigint REFERENCES tenants(id),
  txn_no text NOT NULL,
  vendor_id bigint,
  vendor_name text,
  due_date date,
  bill_amount numeric(14,2),
  amount numeric(14,2) NOT NULL,
  wht_tax_code text,
  wht_income_type text,
  wht_rate numeric(6,4),
  wht_amount numeric(14,2),
  net_amount numeric(14,2),
  status text NOT NULL DEFAULT 'Selected',
  payment_no text,
  gl_ref text,
  fail_reason text,
  cleared boolean DEFAULT false,
  cleared_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ap_payment_run_lines_run ON ap_payment_run_lines (tenant_id, run_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ap_payment_run_lines_glref ON ap_payment_run_lines (gl_ref);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the new tables
-- get RLS with the org-sharing clause. Idempotent; runs on PGlite + Postgres alike.
DO $$ DECLARE r record; BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' LOOP
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
