-- 0415_project_renewals — CRM↔PPM back-flow (control CRM-18).
-- When a project is DELIVERED (status Closed), the customer represents a renewal / expansion motion — but
-- nothing today ensures a renewal opportunity exists, so recurring revenue silently lapses. This table links a
-- delivered project to the renewal opportunity raised from it (idempotent, one per project), so the back-flow
-- is a governed, non-duplicating action and a detective gap list (delivered projects with no renewal motion)
-- can be computed. The renewal opportunity itself is created through the CRM pipeline service (writes stay in
-- the CRM domain); this table is the CRM-owned link + idempotency key.
-- One tenant table (0232 canonical RLS, tenant-leading index).

CREATE TABLE IF NOT EXISTS project_renewals (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  project_code text NOT NULL,                       -- the delivered project (projects.project_code)
  opportunity_no text NOT NULL,                     -- the raised renewal opportunity (crm_opportunities.opp_no)
  account_no text,                                  -- the CRM account the renewal was raised on
  amount numeric(14,2) NOT NULL DEFAULT 0,
  raised_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_renewal ON project_renewals (tenant_id, project_code);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_project_renewals_tenant ON project_renewals (tenant_id, project_code);
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
