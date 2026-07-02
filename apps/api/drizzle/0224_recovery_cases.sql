-- 0224_recovery_cases — docs/29 Phase V2 (control LYL-20): every NPS detractor auto-opens ONE owned,
-- SLA-timed service-recovery case (Open → Contacted → Resolved, actor-stamped). Idempotent per source
-- response (unique source_ref). Tenant-scoped → RLS loop + tenant-leading index (AUD-ARC-01 guard).
CREATE TABLE IF NOT EXISTS recovery_cases (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  member_id bigint NOT NULL REFERENCES pos_members(id),
  source text NOT NULL DEFAULT 'nps',
  source_ref text NOT NULL,
  score integer,
  comment text,
  status text NOT NULL DEFAULT 'Open',
  response_due_at timestamptz,
  contacted_at timestamptz,
  contacted_by text,
  resolved_at timestamptz,
  resolved_by text,
  resolution_note text,
  assignee text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS recovery_cases_source ON recovery_cases (source, source_ref);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS recovery_cases_tenant ON recovery_cases (tenant_id, status);
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
