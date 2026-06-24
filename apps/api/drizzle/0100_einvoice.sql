-- 0100 — C3 (Platform Phase 22) pluggable e-invoicing engine. Per-tenant provider config + an idempotent
-- submission log. Read-of-invoice → external send; posts NOTHING to the GL. New tenant_id tables → RLS loop.
CREATE TABLE IF NOT EXISTS einvoice_config (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  provider_key text NOT NULL,
  config jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS einvoice_submissions (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  doc_ref text NOT NULL,
  provider text,
  status text NOT NULL,
  payload_hash text,
  response jsonb DEFAULT '{}'::jsonb,
  submitted_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_einvoice_doc ON einvoice_submissions (tenant_id, doc_ref);
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
