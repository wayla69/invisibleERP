-- 0101 — CRM Phase 1: PDPA per-purpose consent ledger for loyalty members.
-- New tenant-scoped table (RLS loop re-run). Supersedes pos_members.marketing_opt_in (kept in sync in code).
CREATE TABLE IF NOT EXISTS member_consents (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  member_id bigint REFERENCES pos_members(id),
  purpose text NOT NULL,                 -- marketing | profiling | line | sms | email
  channel text,                          -- optional sub-channel
  granted boolean NOT NULL DEFAULT true,
  source text,                           -- pos | portal | import | admin
  granted_at timestamptz,
  withdrawn_at timestamptz,
  created_by text,
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS member_consents_member_purpose ON member_consents (member_id, purpose);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_member_consents_tenant ON member_consents (tenant_id);
--> statement-breakpoint

-- Re-run the 0002 RLS loop so the new tenant_id table is isolation-scoped.
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
