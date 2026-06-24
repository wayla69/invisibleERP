-- 0090 — Object layouts (Platform Phase 12 — A2). A no-code form/layout for a custom object (Phase 11):
-- sections, field order, columns and hidden fields, optionally per role. `config` is pure presentation,
-- resolved against the object's current field defs at render time (newly-added fields always surface).
-- One row per (tenant, object_key, role) is is_default = the active layout. Never posts to the GL.
-- New tenant_id table → RLS loop re-run.

CREATE TABLE IF NOT EXISTS object_layouts (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  object_key text NOT NULL,
  role text,                                   -- null = all roles (object default)
  name text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { sections:[{title,columns,fields:[field_key]}], hidden:[field_key] }
  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_by text,
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_object_layouts_name ON object_layouts (tenant_id, object_key, name);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_object_layouts_scope ON object_layouts (tenant_id, object_key, role, is_default);
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
