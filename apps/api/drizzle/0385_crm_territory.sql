-- 0385_crm_territory — CRM-11 (persisted territory & quota management, control CRM-10).
-- A governance layer over the REV-17 pipeline: sales territories, rep assignments, and per-period quotas
-- become PERSISTED, auditable master data (today quota_attainment reads an ad-hoc in-memory number). Three
-- tables, read-mostly over crm_opportunities for attainment (no change to lead→convert→opportunity, no GL):
--   • crm_territories — a named territory with match criteria (regions / segments / product categories,
--     jsonb) + a self-referential parent for a team ROLL-UP hierarchy + a manager owner.
--   • crm_territory_members — the reps assigned to a territory (role rep | manager).
--   • crm_quotas — a per-period target for an owner or a territory (scope + subject), so attainment is
--     measured against an auditable quota rather than a number passed at request time.
-- Tenant-scoped (0232 RLS). The migration number is buffered ahead of the concurrently-hot sequence.

CREATE TABLE IF NOT EXISTS crm_territories (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  code text NOT NULL,                          -- TERR-YYYYMMDD-NNN
  name text NOT NULL,
  description text,
  criteria jsonb NOT NULL DEFAULT '{}'::jsonb, -- { regions:[], segments:[], categories:[] }
  parent_territory_id bigint REFERENCES crm_territories(id),  -- team roll-up hierarchy
  manager text,                                -- the territory manager (owner username)
  active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_territory_code ON crm_territories (tenant_id, code);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_territory_parent ON crm_territories (tenant_id, parent_territory_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS crm_territory_members (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  territory_id bigint NOT NULL REFERENCES crm_territories(id),
  owner text NOT NULL,                         -- the rep (crm_opportunities.owner)
  role text NOT NULL DEFAULT 'rep',            -- rep | manager
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_terr_member ON crm_territory_members (tenant_id, territory_id, owner);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_terr_member ON crm_territory_members (tenant_id, territory_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS crm_quotas (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  period text NOT NULL,                         -- 'YYYY-MM' (business month, Asia/Bangkok)
  scope text NOT NULL,                          -- owner | territory
  subject text NOT NULL,                        -- the owner username OR the territory code
  target_amount numeric(14,2) NOT NULL DEFAULT '0',
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_quota ON crm_quotas (tenant_id, period, scope, subject);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_quota_period ON crm_quotas (tenant_id, period);
--> statement-breakpoint

-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the new tables
-- get RLS with the org-sharing clause. Idempotent; runs on PGlite + Postgres alike.
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
