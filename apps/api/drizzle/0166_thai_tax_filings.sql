-- Step 7 — Thai tax filing register. The tax-reports module already COMPUTES ภพ.30 (PP30) + ภงด.3/53
-- (PND) with GL reconciliation, deadlines and PDF export, but nothing PERSISTS a filing: that we filed
-- period 2026-05 on a date, with a Revenue-Department submission reference, and its figures AS FILED. This
-- table snapshots a computed return into a DRAFT→SUBMITTED→ACCEPTED record (one per tenant/type/period),
-- giving the auditable filing trail + the remittance calendar. Tenant-scoped → RLS loop appended below.
CREATE TABLE IF NOT EXISTS thai_tax_filings (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  filing_type text NOT NULL,                          -- 'PP30' | 'PND3' | 'PND53'
  period_month integer NOT NULL,
  period_year integer NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT',               -- 'DRAFT' | 'SUBMITTED' | 'ACCEPTED'
  output_vat numeric(18,2) DEFAULT 0,
  input_vat numeric(18,2) DEFAULT 0,
  net_vat numeric(18,2) DEFAULT 0,
  tax_withheld numeric(18,2) DEFAULT 0,
  deadline date,
  submitted_at timestamptz,
  submission_ref text,
  snapshot jsonb,                                     -- the computed form/totals as filed
  created_by text,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT uq_thai_tax_filing UNIQUE (tenant_id, filing_type, period_month, period_year)
);
--> statement-breakpoint
-- Re-run the RLS loop so the new tenant_id table is isolation-scoped (idempotent — DROP POLICY IF EXISTS).
DO $$ DECLARE r record; BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON public.%I'
      || ' USING (coalesce(current_setting(''app.bypass_rls'',true),'''')=''on'''
      || '   OR tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::bigint)'
      || ' WITH CHECK (coalesce(current_setting(''app.bypass_rls'',true),'''')=''on'''
      || '   OR tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::bigint)', r.table_name);
  END LOOP;
END $$;
