-- 0102 — CRM Phase 1.5: loyalty points-liability GL posting runs (watermarked accrual).
-- New tenant-scoped table (RLS loop re-run). One row per posting run; watermark = MAX(pos_member_ledger.id)
-- processed, so each points movement posts to GL control account 2250 exactly once.
CREATE TABLE IF NOT EXISTS loyalty_posting_runs (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  run_no text NOT NULL,
  watermark_id bigint NOT NULL,                 -- MAX(pos_member_ledger.id) processed (inclusive)
  outstanding_points numeric DEFAULT '0',
  fair_value_per_point numeric(14,6) DEFAULT '0',
  target_liability numeric(18,4) DEFAULT '0',
  prior_liability numeric(18,4) DEFAULT '0',
  liability_delta numeric(18,4) DEFAULT '0',
  earned_points numeric DEFAULT '0',
  redeemed_points numeric DEFAULT '0',
  journal_no text,
  created_by text,
  posted_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_posting_runs_tenant_wm ON loyalty_posting_runs (tenant_id, watermark_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_loyalty_posting_runs_tenant ON loyalty_posting_runs (tenant_id);
--> statement-breakpoint

-- Re-run the 0002 RLS loop so the new tenant_id table is isolation-scoped.
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
