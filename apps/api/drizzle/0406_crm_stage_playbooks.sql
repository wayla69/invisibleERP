-- 0406_crm_stage_playbooks — CRM-7 kanban depth (control CRM-13).
-- A per-stage PLAYBOOK on the REV-17 pipeline: the exit criteria a deal must satisfy to ENTER a stage.
-- wip_limit caps how many OPEN opportunities may sit in the stage at once (null = unlimited; ignored for the
-- terminal Won/Lost stages); required_fields is a whitelist-validated list of opportunity field keys that must
-- be populated before a deal advances into the stage; guidance is the coach's note the kanban board shows.
-- One row per (tenant, stage). Enforced server-side in setStage (STAGE_REQUIREMENTS_UNMET / WIP_LIMIT_EXCEEDED).
-- One tenant table (0232 canonical RLS, tenant-leading index).

CREATE TABLE IF NOT EXISTS crm_stage_playbooks (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  stage_id bigint NOT NULL REFERENCES pipeline_stages(id),
  wip_limit integer,                              -- max OPEN opps in this stage; null = unlimited
  required_fields jsonb NOT NULL DEFAULT '[]',    -- string[] of opportunity field keys (whitelist)
  guidance text,                                  -- exit-criteria playbook note shown on the board
  is_active boolean NOT NULL DEFAULT true,
  updated_by text,
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_stage_playbook ON crm_stage_playbooks (tenant_id, stage_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_stage_playbook_tenant ON crm_stage_playbooks (tenant_id, stage_id);
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
