-- 0400_resource_skills_calendar — PPM-A1 (docs/44): resource capacity heatmap + skills/role supply-vs-demand
-- (control PROJ-20). Extends the existing PROJ-05 resourcing engine (projects-resourcing.service.ts
-- resourceCapacity/resourceUtilization) — no core-formula rewrite, additive fields only:
--   • resource_skills — which real, NAMED people can fill a role/skill (the supply side of role/skill
--     supply-vs-demand, and the named-vs-generic booking flag on the heatmap: an assignment whose
--     resource_name has no row here is a GENERIC placeholder booking, e.g. "Senior Dev TBD").
--   • resource_calendar — a per-resource, per-month availability CEILING (default 100% when no row exists),
--     so over-allocation is flagged against a resource's TRUE availability (a 50%-part-time person flagged
--     over-allocated at 60%, not only above a flat 100% assumption).
-- Tenant-scoped (0232 RLS). Migration number is the next free 4-digit id.

CREATE TABLE IF NOT EXISTS resource_skills (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  resource_name text NOT NULL,
  skill text NOT NULL,             -- same free-text space as project_resources.role
  proficiency text,                -- e.g. junior | mid | senior (optional)
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_rskill_resource ON resource_skills (tenant_id, resource_name);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_rskill_skill ON resource_skills (tenant_id, skill);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_rskill_resource_skill ON resource_skills (tenant_id, resource_name, skill);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS resource_calendar (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  resource_name text NOT NULL,
  month date NOT NULL,             -- first-of-month, e.g. 2026-07-01
  available_pct numeric(5,2) NOT NULL DEFAULT '100',
  reason text,                     -- e.g. PTO | part_time | leave
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_rcal_resource ON resource_calendar (tenant_id, resource_name);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_rcal_resource_month ON resource_calendar (tenant_id, resource_name, month);
--> statement-breakpoint

-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) for the two new
-- tables. Idempotent; runs on PGlite + Postgres alike.
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
