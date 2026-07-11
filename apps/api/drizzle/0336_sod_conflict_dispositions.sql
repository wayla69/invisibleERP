-- 0336_sod_conflict_dispositions — GRC-5 (ITGC-AC-22): SoD-Conflict Register + Compensating-Control
-- governance. SoD conflicts are computed LIVE per-user (detectSodConflicts over SOD_RULES R01..R21 in
-- permissions.ts) and BLOCKED at grant time (admin-users.service.ts sodConflictOrThrow, ITGC-AC-09), but
-- there was NO standing register of ACCEPTED conflicts — a conflict a company consciously accepts with a
-- documented compensating control, an owner, an expiry and a periodic re-review. This adds, ALONGSIDE the
-- preventive enforcement (no change to SOD_RULES / detectSodConflicts / access_grant_exceptions):
--   • sod_conflict_dispositions — one row per (rule_id, username) governance decision. Lifecycle
--     open → accepted → mitigated → resolved. An `accepted` disposition MUST carry a compensating_control,
--     owner and expiry_date, records who accepted it (accepted_by / accepted_at), and is periodically
--     re-reviewed (last_reviewed_at). Detective read: accepted conflicts past expiry OR overdue for
--     re-review (the expired worklist). The live conflict scan itself stays computed from user_permissions.
-- Tenant-scoped: a leading (tenant_id, …) index + the CANONICAL 0232-form tenant_isolation RLS policy
-- (re-applied via the generic DO-loop below) + app_user grants. Idempotent; PGlite + Postgres alike.
CREATE TABLE IF NOT EXISTS sod_conflict_dispositions (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  rule_id text NOT NULL,                 -- SOD_RULES id, e.g. R07
  username text NOT NULL,                -- the user holding both sides of the conflict
  status text NOT NULL DEFAULT 'open',   -- open | accepted | mitigated | resolved
  compensating_control text,             -- mandatory when accepted
  owner text,                            -- accountable owner of the compensating control
  accepted_by text,                      -- who accepted the residual risk (recorded as evidence)
  accepted_at timestamptz,
  expiry_date date,                      -- acceptance expiry — re-decision required by this date
  last_reviewed_at timestamptz,          -- periodic re-review stamp
  notes text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_sod_conflict_dispositions_tenant ON sod_conflict_dispositions (tenant_id, status);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_sod_conflict_dispositions_rule_user ON sod_conflict_dispositions (tenant_id, rule_id, username);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the new table
-- gets RLS with the org-sharing clause. Idempotent; runs on PGlite + Postgres alike.
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
