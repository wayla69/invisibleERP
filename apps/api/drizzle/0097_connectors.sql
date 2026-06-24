-- 0097 — D2 (Platform Phase 24) connector framework. Inbound integrations over a canonical model: a
-- connector + a per-run sync log + an external-id map for idempotent dedupe. Imported data is surfaced for
-- review, never auto-posted. New tenant_id tables → RLS loop re-run. No GL.

CREATE TABLE IF NOT EXISTS connectors (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  type text NOT NULL,                          -- line | shopee | bank_csv
  label text,
  status text NOT NULL DEFAULT 'connected',
  config jsonb DEFAULT '{}'::jsonb,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS connector_syncs (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  connector_id bigint,
  status text NOT NULL,
  pulled bigint DEFAULT 0,
  created_count bigint DEFAULT 0,
  detail text,
  ran_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS external_id_map (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  connector_type text NOT NULL,
  canonical_type text NOT NULL,
  external_id text NOT NULL,
  local_ref text,
  seen_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_external_id ON external_id_map (tenant_id, connector_type, canonical_type, external_id);
--> statement-breakpoint

-- Re-run the 0002 RLS loop so the new tenant_id tables are isolation-scoped.
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
