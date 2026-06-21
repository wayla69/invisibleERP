-- Phase 15 — Accounting Tier 3 (batch 2): Revenue Recognition / Deferred Revenue (รายได้รอตัดบัญชี).
-- Cash-in-advance → 2400 Unearned Revenue (liability), recognized straight-line into 4000 Sales over the term.
CREATE TABLE IF NOT EXISTS rev_rec_schedules (
  id bigserial PRIMARY KEY,
  schedule_no text NOT NULL UNIQUE,
  tenant_id bigint REFERENCES tenants(id),
  source_ref text,
  total_amount numeric(18,4) NOT NULL,
  start_period text NOT NULL,
  end_period text NOT NULL,
  months integer NOT NULL,
  method text NOT NULL DEFAULT 'straight_line',
  deferred_account text NOT NULL DEFAULT '2400',
  revenue_account text NOT NULL DEFAULT '4000',
  currency text DEFAULT 'THB',
  status text NOT NULL DEFAULT 'active',
  deferral_journal_no text,
  notes text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_revrec_sched_tenant ON rev_rec_schedules(tenant_id);

CREATE TABLE IF NOT EXISTS rev_rec_lines (
  id bigserial PRIMARY KEY,
  schedule_id bigint NOT NULL REFERENCES rev_rec_schedules(id),
  tenant_id bigint REFERENCES tenants(id),
  period text NOT NULL,
  amount numeric(18,4) NOT NULL,
  recognized boolean NOT NULL DEFAULT false,
  journal_no text
);
CREATE INDEX IF NOT EXISTS idx_revrec_line_sched ON rev_rec_lines(schedule_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_revrec_line ON rev_rec_lines(schedule_id, period);

-- Re-run the 0002 RLS loop so rev_rec_schedules + rev_rec_lines (tenant_id) are isolation-scoped.
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
