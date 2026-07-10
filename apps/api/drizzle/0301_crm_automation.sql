-- 0301_crm_automation — CRM-4 automation: lead scoring + follow-up discipline (docs/41 CRM-4, new control REV-22).
-- Two tenant-scoped tables back the CRM-4 automation surface:
--  (1) crm_lead_scores — ONE explainable, versioned rules-based score per (tenant, lead). The grade (A–D)
--      and its per-factor breakdown are stored so lead prioritisation is auditable (SOX posture; mirrors the
--      customer_profiles churn/LTV formula pattern — coefficients live in code, every row carries a version).
--  (2) crm_followup_settings — ONE row per tenant. sla_hours: a new lead must be touched (an activity logged)
--      within N hours or it is an SLA breach surfaced by the follow-up center (detective control REV-22).
--      rotting_days: an open deal with no activity for N days is flagged rotting. round_robin_owners drives
--      the per-pipeline round-robin owner assignment (rr_cursor = next index).
CREATE TABLE IF NOT EXISTS crm_lead_scores (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  lead_no text NOT NULL,
  score integer NOT NULL DEFAULT 0,               -- 0..100 weighted total
  grade text NOT NULL DEFAULT 'D',                 -- A | B | C | D
  version text NOT NULL,                           -- formula version stamp (e.g. 'v1')
  breakdown jsonb,                                  -- explainability: [{ factor, points, detail }]
  scored_at timestamptz DEFAULT now(),
  CONSTRAINT uq_crm_lead_score UNIQUE (tenant_id, lead_no)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_lead_score_grade ON crm_lead_scores (tenant_id, grade);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS crm_followup_settings (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  sla_hours integer NOT NULL DEFAULT 24,
  rotting_days integer NOT NULL DEFAULT 7,
  round_robin_owners jsonb NOT NULL DEFAULT '[]',  -- string[] of usernames
  rr_cursor integer NOT NULL DEFAULT 0,
  updated_by text,
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT uq_crm_followup_settings UNIQUE (tenant_id)
);
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
