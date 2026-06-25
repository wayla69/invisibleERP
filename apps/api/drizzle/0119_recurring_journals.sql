-- 0119 — Recurring / template journal entries (GL-08). A balanced template + a cadence; the scheduled
-- job posts each due template as a DRAFT JE through maker-checker and rolls next_run_date forward.
-- New tenant_id table → RLS loop re-run.
CREATE TABLE IF NOT EXISTS recurring_journals (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  name text NOT NULL,
  frequency text NOT NULL,
  memo text,
  ledger_code text,
  currency text DEFAULT 'THB',
  lines jsonb NOT NULL,
  active text DEFAULT 'true',
  next_run_date date,
  last_run_date date,
  last_entry_no text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_recurring_due ON recurring_journals (active, next_run_date);
--> statement-breakpoint
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
