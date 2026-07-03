-- 0230 — Production drift repair (2026-07-03 deploy-outage incident). Prod's DB was found to be
-- missing the 0146_tip_distribution tables (relation "tip_distribution_lines" does not exist, 42P01),
-- a legacy of the historical duplicate-number/renumber events — fresh DBs are unaffected. The gap
-- crashed boot-time `drizzle-kit migrate` at 0218's tenant-index backfill (now table-guarded) and
-- would 500 the tips feature (TIP-01) at runtime. This re-runs 0146's idempotent DDL verbatim:
-- no-op wherever the tables already exist, heals prod where they don't. Root-cause context:
-- docs/ops/drizzle-migration-debt.md.
CREATE TABLE IF NOT EXISTS tip_distributions (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  dist_no text NOT NULL,
  period_from text NOT NULL,
  period_to text NOT NULL,
  method text NOT NULL DEFAULT 'equal',
  pool_amount numeric(18,4) NOT NULL,
  pay_account text NOT NULL DEFAULT '1000',
  journal_no text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS tip_distribution_lines (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  dist_id bigint NOT NULL REFERENCES tip_distributions(id),
  staff text NOT NULL,
  basis numeric(18,4) NOT NULL DEFAULT 0,
  share numeric(9,6) NOT NULL DEFAULT 0,
  amount numeric(18,4) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tip_dist_period ON tip_distributions (tenant_id, period_from, period_to);
--> statement-breakpoint
-- tenant-leading indexes 0218 would have created had the tables existed there (idempotent everywhere)
CREATE INDEX IF NOT EXISTS idx_tip_distributions_tenant ON tip_distributions (tenant_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tip_distribution_lines_tenant ON tip_distribution_lines (tenant_id);
--> statement-breakpoint
-- Re-run the RLS loop so the (re)created tenant_id tables are isolation-scoped (idempotent).
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
