-- 0078 — Custom fields (UDFs). A per-tenant registry of user-defined fields keyed by entity (customer,
-- item, sales_order, journal, …) plus a typed value store keyed by (entity, field_key, record_id). Lets a
-- tenant extend any master/transaction without code. New tenant_id tables → RLS loop re-run.

CREATE TABLE IF NOT EXISTS custom_field_defs (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  entity text NOT NULL,                  -- customer | item | sales_order | journal | ... (target record type)
  field_key text NOT NULL,               -- slug, unique per tenant+entity
  label text NOT NULL,
  label_en text,
  data_type text NOT NULL DEFAULT 'text',-- text | number | date | boolean | select
  options jsonb,                         -- choices for data_type=select
  required boolean NOT NULL DEFAULT false,
  default_value text,
  help_text text,
  sort integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_field_def ON custom_field_defs (tenant_id, entity, field_key);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS custom_field_values (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  entity text NOT NULL,
  field_key text NOT NULL,
  record_id text NOT NULL,               -- business/PK id of the target record
  value_text text,                       -- one of these is set per the def's data_type
  value_num numeric(18,4),
  value_date date,
  value_bool boolean,
  updated_by text,
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_field_value ON custom_field_values (tenant_id, entity, field_key, record_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_custom_field_value_rec ON custom_field_values (tenant_id, entity, record_id);
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
