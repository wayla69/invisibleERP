-- 0091 — Automation rules engine (Platform Phase 13 — A4). A no-code "when EVENT [and CONDITION] then
-- ACTION" engine over the events the app already emits (po.approved, po.rejected, alert.fired). A rule's
-- ACTION is a non-GL, non-destructive side effect (in-app notification / LINE·SMS·email message / log).
-- New tenant_id tables → RLS loop re-run.

CREATE TABLE IF NOT EXISTS automation_rules (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  name text NOT NULL,
  event_type text NOT NULL,                  -- po.approved | po.rejected | alert.fired
  condition jsonb,                           -- null = always; else { field, op, value }
  action jsonb NOT NULL,                     -- { type: notification|message|log, ... }
  active boolean NOT NULL DEFAULT true,
  last_fired_at timestamptz,
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_by text,
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_automation_rules_scope ON automation_rules (tenant_id, event_type, active);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS automation_executions (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  rule_id bigint,
  event_type text,
  status text NOT NULL,                      -- executed | skipped | failed
  detail text,
  fired_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_automation_exec_scope ON automation_executions (tenant_id, fired_at);
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
