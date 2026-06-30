-- 0202_governance — entity-level governance evidence capture (W3). Scaffolds the SYSTEM side of two
-- previously-Gap controls (the policy + governance bodies remain an org/PMO process, so the controls move
-- to Partial): ELC-01 code-of-conduct annual acknowledgement register, and ELC-04 whistleblower/ethics
-- hotline intake + case log. Both tenant-scoped → re-run the RLS loop so the new tables get tenant_isolation.
CREATE TABLE IF NOT EXISTS ethics_acknowledgements (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  username text NOT NULL,
  policy_version text NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ethics_ack_tenant_user_version_uq ON ethics_acknowledgements (tenant_id, username, policy_version);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS whistleblower_cases (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  case_ref text NOT NULL UNIQUE,
  category text,
  allegation text NOT NULL,
  reporter text,
  anonymous boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'received',  -- received | investigating | resolved | dismissed
  resolution_note text,
  handled_by text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
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
