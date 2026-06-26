-- 0144 — Management budget-variance review sign-off (ELC-06). Budget-vs-actual produced numbers but nothing
-- recorded that management actually REVIEWED the material variances and followed them up — the entity-level
-- control "errors in results undetected by management" was only Partial. budget_reviews is an append-only log
-- of recorded reviews: who signed off on a (fiscal_year[, period][, cost_center]) variance report, when, the
-- number of material variance lines and the unfavourable total at review time, and the follow-up note. The
-- budget-vs-actual report flags material variances (requires_review) and shows the latest sign-off.
CREATE TABLE IF NOT EXISTS budget_reviews (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  fiscal_year integer NOT NULL,
  period text,                                         -- 'YYYY-MM' or null = full year
  cost_center_code text,
  material_count integer NOT NULL DEFAULT 0,           -- # material variance lines at review time
  unfavorable_total numeric(18,4) NOT NULL DEFAULT 0,  -- Σ unfavourable variance at review time
  notes text,                                          -- management's review conclusion + variance follow-up
  reviewed_by text,
  reviewed_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_budget_review_period ON budget_reviews (tenant_id, fiscal_year, period);

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
