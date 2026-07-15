-- 0412_program_benefits — PPM Wave P4 program benefits realization (control PROJ-27).
-- Benefits are the justification for a program's investment. A program declares expected BENEFITS (a baseline,
-- a target, a target date, an owner); actual measurements are logged over time (append-only); the realization
-- view compares actual vs target and flags shortfalls. CLOSING a benefit as realized / not_realized is a
-- maker-checker sign-off (confirmer <> the benefit's author → SOD_SELF_APPROVAL), so a program owner cannot
-- self-certify that promised value was delivered. Prevents benefits leakage — a program declared "done" while
-- delivering little of what it was funded for. Programs are identified by projects.program_code (no master
-- table), so a benefit references a program_code that at least one project carries.
-- Two tenant tables (0232 canonical RLS, tenant-leading indexes).

CREATE TABLE IF NOT EXISTS program_benefits (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  program_code text NOT NULL,                      -- matches projects.program_code
  benefit_no text NOT NULL,                        -- PB-#### per tenant
  name text NOT NULL,
  category text NOT NULL DEFAULT 'financial',       -- financial | non_financial
  unit text,                                        -- THB | % | count | ...
  baseline_value numeric(18,2) NOT NULL DEFAULT 0,
  target_value numeric(18,2) NOT NULL,
  target_date date,
  owner text,
  status text NOT NULL DEFAULT 'open',              -- open | realized | not_realized
  created_by text NOT NULL,
  confirmed_by text,                                -- reviewer — must differ from created_by (SoD)
  confirmed_at timestamptz,
  confirm_notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_program_benefit_no ON program_benefits (tenant_id, benefit_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_program_benefits_tenant ON program_benefits (tenant_id, program_code);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS program_benefit_measurements (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  benefit_id bigint NOT NULL REFERENCES program_benefits(id),
  measured_value numeric(18,2) NOT NULL,
  measured_at date NOT NULL,
  note text,
  recorded_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_program_benefit_measurements_tenant ON program_benefit_measurements (tenant_id, benefit_id);
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
