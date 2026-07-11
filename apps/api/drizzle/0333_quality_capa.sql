-- 0333_quality_capa — QMS-2: CAPA (Corrective & Preventive Action) lifecycle with effectiveness sign-off.
-- The system captured one-off quality dispositions (mfg-depth) + supplier claims (gr_claims) but had no
-- MANAGED corrective-action loop: root-cause → action plan → verification → effectiveness sign-off → closure.
-- This adds a first-class CAPA register (control QC-02) whose CLOSURE requires an INDEPENDENT effectiveness
-- verification (verified_by ≠ owner/created_by → SOD_SELF_APPROVAL) and completion of every child action.
--   • capas         — the CAPA header (capa_no unique per tenant; generic nullable source_type/source_ref
--                     link to an NCR/gr_claim/complaint/audit — NOT a FK, so this builds standalone).
--   • capa_actions  — child action items (a CAPA cannot close until every action is 'done').
-- Each table is tenant-scoped: a leading (tenant_id,…) index + the CANONICAL 0232-form tenant_isolation RLS
-- policy (re-applied via the generic DO-loop below) + app_user grants. Idempotent; PGlite + Postgres alike.
CREATE TABLE IF NOT EXISTS capas (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  capa_no text NOT NULL,
  source_type text, -- ncr | gr_claim | complaint | audit | manual (generic link, no FK)
  source_ref text,
  title text NOT NULL,
  problem_statement text,
  root_cause text,
  action_type text NOT NULL DEFAULT 'corrective', -- corrective | preventive | both
  owner text NOT NULL,
  target_date date,
  status text NOT NULL DEFAULT 'open', -- open | in_progress | pending_verification | closed | cancelled
  effectiveness_result text, -- effective | ineffective | null
  verified_by text,
  verified_at timestamptz,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_capas_tenant ON capas (tenant_id, status);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_capas_no ON capas (tenant_id, capa_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_capas_target ON capas (tenant_id, target_date);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS capa_actions (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  capa_id bigint NOT NULL REFERENCES capas(id),
  seq bigint NOT NULL DEFAULT 1,
  description text NOT NULL,
  owner text,
  due_date date,
  status text NOT NULL DEFAULT 'pending', -- pending | done
  completed_by text,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_capa_actions_tenant ON capa_actions (tenant_id, capa_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_capa_actions_capa ON capa_actions (capa_id);
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
