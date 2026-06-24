-- 0089 — Custom objects (Platform Phase 11 — A1). Tenant-defined record types ("custom apps") with no code:
-- a registry of objects (`custom_objects`) and a registry of their records (`custom_object_records`). The
-- records' typed field VALUES reuse the Phase 1 custom-fields store (`custom_field_values`, keyed by
-- entity = object_key), so a custom object's fields are literally custom fields on its own entity. Pure
-- metadata — never posts to the GL. New tenant_id tables → RLS loop re-run.

CREATE TABLE IF NOT EXISTS custom_objects (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  object_key text NOT NULL,                   -- slug; used as the custom-fields `entity`
  label text NOT NULL,
  label_en text,
  icon text,
  active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_objects_key ON custom_objects (tenant_id, object_key);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS custom_object_records (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  object_key text NOT NULL,
  record_id text NOT NULL,                     -- our own id (String(id)); the key into custom_field_values
  display_name text,
  active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_by text,
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_object_records_id ON custom_object_records (tenant_id, object_key, record_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_custom_object_records_scope ON custom_object_records (tenant_id, object_key, active);
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
