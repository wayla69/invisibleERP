-- Adversarial-verify fixes:
-- #1 ap_transactions gets tenant_id so input VAT (ภ.พ.30) is tenant-scoped like output VAT.
-- #4 UNIQUE(source, source_ref) on journal_entries backstops GL idempotency (DEP/ASSET/RTN/CASHMOV)
--    against concurrent/retried double-posts. Partial: only when source_ref is set (Manual/test legs are null).
ALTER TABLE ap_transactions ADD COLUMN IF NOT EXISTS tenant_id bigint REFERENCES tenants(id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_je_source_ref ON journal_entries (source, source_ref) WHERE source_ref IS NOT NULL;

-- Re-run the 0002 RLS loop so ap_transactions (now tenant_id) is isolation-scoped.
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
