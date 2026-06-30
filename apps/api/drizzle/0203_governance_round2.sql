-- 0203_governance_round2 — entity-level governance evidence capture, round 2 (W5). Scaffolds the SYSTEM
-- side of the last three Gap controls (the human governance — DoA policy sign-off, audit-committee meetings,
-- the fraud-risk assessment itself — remains an org/PMO process, so these move Gap → Partial):
--   ELC-03 delegation-of-authority matrix, ELC-05 fraud-risk register, ELC-02 audit-committee oversight log.
-- All tenant-scoped → re-run the RLS loop so the new tables get tenant_isolation.
CREATE TABLE IF NOT EXISTS delegation_of_authority (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  authority_area text NOT NULL,
  role text NOT NULL,
  approval_limit numeric(16,2),
  currency text NOT NULL DEFAULT 'THB',
  notes text,
  effective_from date,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS doa_tenant_area_role_uq ON delegation_of_authority (tenant_id, authority_area, role);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fraud_risks (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  risk_ref text NOT NULL UNIQUE,
  area text NOT NULL,
  description text NOT NULL,
  likelihood text NOT NULL DEFAULT 'medium',
  impact text NOT NULL DEFAULT 'medium',
  mitigating_controls text,
  owner text,
  status text NOT NULL DEFAULT 'open',  -- open | mitigated | accepted | closed
  last_reviewed_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS governance_oversight (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  meeting_date date NOT NULL,
  kind text NOT NULL DEFAULT 'audit_committee',
  topics text,
  icfr_reviewed boolean NOT NULL DEFAULT false,
  findings_reviewed text,
  attendees text,
  minutes_ref text,
  signed_off_by text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
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
