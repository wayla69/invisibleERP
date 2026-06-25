-- 0110 — AR collections / dunning. Records each dunning action taken on an open receivable so the
-- collections worklist can derive the current stage and escalate. New tenant_id table → RLS loop re-run.
CREATE TABLE IF NOT EXISTS ar_dunning_log (
  id bigserial PRIMARY KEY,
  dunning_no text NOT NULL UNIQUE,
  tenant_id bigint REFERENCES tenants(id),
  invoice_no text NOT NULL,
  stage text NOT NULL,
  channel text DEFAULT 'email',
  days_overdue bigint,
  outstanding numeric(14,2),
  promise_to_pay_date date,
  notes text,
  actioned_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ix_ar_dunning_invoice ON ar_dunning_log (invoice_no);
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
