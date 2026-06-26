-- Step 10 — feature flags / "Labs". A registry of optional modules so a tenant can hide the thin,
-- demo-grade modules (consolidation, intercompany, mfg-MRP, sourcing/RFQ, gamification, referrals, wheels,
-- custom-objects) behind a Labs section and present a tight, deep core to diligence — re-enabling per real
-- demand. The default registry lives in code (CORE on / LABS off); this table holds per-tenant overrides.
CREATE TABLE IF NOT EXISTS feature_flags (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  flag_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT uq_feature_flag UNIQUE (tenant_id, flag_key)
);
--> statement-breakpoint
-- Re-run the RLS loop so the new tenant_id table is isolation-scoped (idempotent — DROP POLICY IF EXISTS).
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
