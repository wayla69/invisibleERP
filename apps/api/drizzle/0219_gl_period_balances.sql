-- 0219_gl_period_balances — GL period-balance snapshots (docs/27 R1-2, investment-audit finding AUD-ARC-02).
-- The trial balance aggregated the FULL journal_lines table on every request; at millions of lines the
-- read path melts the DB. This snapshot holds Σdebit/Σcredit per (tenant, ledger, period, cost-center,
-- account), maintained TRANSACTIONALLY at the only two balance-affecting transitions (postEntry lands
-- Posted; approveEntry Draft→Posted — Posted entries are DB-immutable per 0165, corrections are contra
-- reversals which post normally), and verified against the raw ledger at close (control GL-20).
-- Key columns are normalized NON-NULL ('' stands for NULL ledger/cost-center) so a plain unique index +
-- ON CONFLICT upsert work; tenant_id stays nullable to mirror journal_entries (RLS loop below).
CREATE TABLE IF NOT EXISTS gl_period_balances (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  ledger_code text NOT NULL DEFAULT '',
  period text NOT NULL DEFAULT '',
  cost_center_code text NOT NULL DEFAULT '',
  account_code text NOT NULL,
  debit numeric(18,4) NOT NULL DEFAULT 0,
  credit numeric(18,4) NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ux_gl_period_balances ON gl_period_balances
  (coalesce(tenant_id, 0), ledger_code, period, cost_center_code, account_code);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gl_period_balances_tenant ON gl_period_balances (tenant_id);
--> statement-breakpoint
-- Backfill from the existing Posted ledger — only when the snapshot is empty (idempotent re-run).
INSERT INTO gl_period_balances (tenant_id, ledger_code, period, cost_center_code, account_code, debit, credit)
SELECT je.tenant_id, coalesce(je.ledger_code, ''), coalesce(je.period, ''), coalesce(jl.cost_center_code, ''),
       jl.account_code, coalesce(sum(jl.debit), 0), coalesce(sum(jl.credit), 0)
FROM journal_lines jl
JOIN journal_entries je ON je.id = jl.entry_id
WHERE je.status = 'Posted'
  AND NOT EXISTS (SELECT 1 FROM gl_period_balances LIMIT 1)
GROUP BY je.tenant_id, coalesce(je.ledger_code, ''), coalesce(je.period, ''), coalesce(jl.cost_center_code, ''), jl.account_code;
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
