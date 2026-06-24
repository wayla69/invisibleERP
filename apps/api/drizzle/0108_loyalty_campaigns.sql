-- 0108 — CRM Phase 4: campaign orchestration (segmented + scheduled broadcasts). New tenant_id table → RLS loop.
CREATE TABLE IF NOT EXISTS loyalty_campaigns (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  campaign_code text NOT NULL,
  name text NOT NULL,
  channel text NOT NULL DEFAULT 'sms',
  audience text NOT NULL DEFAULT 'all',
  segment text,
  tier text,
  body text NOT NULL,
  schedule_at timestamptz,
  status text NOT NULL DEFAULT 'draft',
  targeted integer DEFAULT 0,
  sent_count integer DEFAULT 0,
  skipped_count integer DEFAULT 0,
  failed_count integer DEFAULT 0,
  created_by text,
  created_at timestamptz DEFAULT now(),
  sent_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS loyalty_campaigns_tenant ON loyalty_campaigns (tenant_id, status);
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
