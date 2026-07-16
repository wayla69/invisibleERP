-- 0421_close_task_templates — Close Manager: per-tenant configurable close tasks (docs/50 Wave 3 B1;
-- extends GL-15/GL-16, no control-semantics change). The fixed 9-step checklist becomes the DEFAULT: a
-- tenant may add its own close tasks (or override a standard step's title/required flag by reusing its
-- step_key) with an owner role, a due-day offset from period end, and a predecessor dependency that gates
-- sign-off order. startClose seeds standard + active tenant templates; a tenant with no templates is
-- byte-identical to today. Lock semantics unchanged: all REQUIRED steps Done → ReadyToLock → maker-checker
-- lock (SELF_LOCK). One tenant table (0232 canonical RLS) + three additive columns on close_run_steps.
CREATE TABLE IF NOT EXISTS close_task_templates (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  step_key text NOT NULL,
  title text NOT NULL,
  required boolean NOT NULL DEFAULT true,
  seq integer NOT NULL DEFAULT 100,
  owner_role text,
  due_day_offset integer,
  depends_on_key text,
  active boolean NOT NULL DEFAULT true,
  updated_by text,
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_close_task_templates ON close_task_templates (tenant_id, step_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_close_task_templates_tenant ON close_task_templates (tenant_id);
--> statement-breakpoint
ALTER TABLE close_run_steps ADD COLUMN IF NOT EXISTS owner_role text;
--> statement-breakpoint
ALTER TABLE close_run_steps ADD COLUMN IF NOT EXISTS due_date date;
--> statement-breakpoint
ALTER TABLE close_run_steps ADD COLUMN IF NOT EXISTS depends_on_key text;
--> statement-breakpoint

-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form). Idempotent.
DO $$ DECLARE r record; BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I'
      || ' USING (coalesce(current_setting(''app.bypass_rls'', true), '''') = ''on'''
      || '        OR tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint'
      || '        OR (nullif(current_setting(''app.org_id'', true), '''') IS NOT NULL'
      || '            AND tenant_id IN (SELECT id FROM tenants WHERE org_id = nullif(current_setting(''app.org_id'', true), '''')::bigint)))'
      || ' WITH CHECK (coalesce(current_setting(''app.bypass_rls'', true), '''') = ''on'''
      || '        OR tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint'
      || '        OR (nullif(current_setting(''app.org_id'', true), '''') IS NOT NULL'
      || '            AND tenant_id IN (SELECT id FROM tenants WHERE org_id = nullif(current_setting(''app.org_id'', true), '''')::bigint)))',
      r.table_name);
  END LOOP;
END $$;
