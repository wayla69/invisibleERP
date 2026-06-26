-- Step 2 — POS-07: signed, persisted, tamper-evident Z-report archive. The live X/Z endpoints compute
-- the shift totals on demand; signing snapshots them into an immutable record (content_hash over the
-- canonical totals) with a manager attestation (pos_close) + denomination breakdown, so the close-of-day
-- tape can be proven unaltered to an auditor. Both tables are tenant-scoped → RLS loop appended below.
CREATE TABLE IF NOT EXISTS xz_reports (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  till_session_id bigint REFERENCES till_sessions(id),
  report_type text NOT NULL,                          -- 'X' | 'Z'
  generated_at timestamptz DEFAULT now(),
  generated_by text,
  gross_sales numeric(18,4) DEFAULT 0,
  total_cash numeric(18,4) DEFAULT 0,
  total_card numeric(18,4) DEFAULT 0,
  total_refund numeric(18,4) DEFAULT 0,
  txn_count integer DEFAULT 0,
  void_count integer DEFAULT 0,
  cash_expected numeric(18,4) DEFAULT 0,
  cash_counted numeric(18,4),
  variance numeric(18,4),
  status text NOT NULL DEFAULT 'SIGNED',              -- DRAFT | SIGNED
  content_hash text,                                  -- sha256 of the canonical totals (tamper-evidence)
  html_snapshot text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_xz_reports_till ON xz_reports (tenant_id, till_session_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS xz_report_denominations (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  report_id bigint NOT NULL REFERENCES xz_reports(id),
  denomination numeric(10,2) NOT NULL,
  count integer NOT NULL DEFAULT 0,
  total numeric(18,4) NOT NULL DEFAULT 0
);
--> statement-breakpoint
-- Re-run the RLS loop so the new tenant_id tables are isolation-scoped (idempotent — DROP POLICY IF EXISTS).
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
