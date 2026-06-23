-- 0074 — Receipts & printing: a server-side print-job queue. Receipts/kitchen tickets are rendered
-- server-side (HTML + ESC/POS) and queued here; a CloudPRNT-capable printer or a small local agent
-- pulls jobs (GET next → ack). New tenant_id table → RLS loop re-run.
CREATE TABLE IF NOT EXISTS print_jobs (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  branch_id bigint,
  job_type text NOT NULL,                -- receipt | kitchen
  station text,                          -- kitchen station code (kitchen tickets)
  sale_no text,
  order_no text,
  format text NOT NULL DEFAULT 'escpos', -- escpos | html
  payload text NOT NULL,
  printer_id text,                       -- target printer / agent id (null = any)
  status text NOT NULL DEFAULT 'queued', -- queued | sent | printed | failed
  attempts integer NOT NULL DEFAULT 0,
  error text,
  created_by text,
  created_at timestamptz DEFAULT now(),
  printed_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_print_jobs_pull ON print_jobs (tenant_id, status, id);
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
