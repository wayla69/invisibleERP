-- 0349_income_tax_provision — TAX-11: Current income-tax provision + ETR reconciliation (ASC 740 / IAS 12,
-- current side). A period-scoped, idempotent run (one row per (tenant, period)) wrapping the current-tax
-- numerics in a maker-checker run→post lifecycle: pretax book income (from the income statement) → permanent
-- + temporary book-to-tax adjustments → taxable income → current CIT @ statutory rate → CIT payable. The
-- DEFERRED side stays in deferred_tax_runs (TAX-06); this table LINKS to it. Posting the provision books
-- Dr 5960 (current CIT expense) / Cr 2110 (CIT payable); the poster must differ from the runner
-- (403 SOD_SELF_APPROVAL). Reuses the gl_post/gl_close/exec finance duties — no new permission/SoD rule.
--
-- One tenant-scoped table: a leading (tenant_id, …) index + the CANONICAL 0232-form tenant_isolation RLS
-- policy (re-applied via the generic DO-loop below) + app_user grants. Also registers the TAX.PROVISION
-- posting-event type for /setup/posting-rules. Idempotent; PGlite + Postgres alike.
CREATE TABLE IF NOT EXISTS income_tax_provisions (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  period text NOT NULL,
  fiscal_year integer,
  from_date date NOT NULL,
  to_date date NOT NULL,
  pretax_book_income numeric(18,4) NOT NULL DEFAULT 0,
  permanent_diffs jsonb,
  temporary_diffs jsonb,
  permanent_adj_total numeric(18,4) NOT NULL DEFAULT 0,
  temporary_adj_total numeric(18,4) NOT NULL DEFAULT 0,
  taxable_income numeric(18,4) NOT NULL DEFAULT 0,
  statutory_rate numeric(9,6) NOT NULL DEFAULT 0.20,
  current_tax numeric(18,4) NOT NULL DEFAULT 0,
  valuation_allowance numeric(18,4) NOT NULL DEFAULT 0,
  rate_change_effect numeric(18,4) NOT NULL DEFAULT 0,
  other_adjustments numeric(18,4) NOT NULL DEFAULT 0,
  deferred_tax_link jsonb,
  total_provision numeric(18,4) NOT NULL DEFAULT 0,
  effective_rate numeric(9,6) NOT NULL DEFAULT 0,
  etr_lines jsonb,
  status text NOT NULL DEFAULT 'Open',
  posted_entry_id text,
  run_by text,
  posted_by text,
  posted_at timestamptz,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_income_tax_provisions_period ON income_tax_provisions (tenant_id, period);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_income_tax_provisions_tenant ON income_tax_provisions (tenant_id, status);
--> statement-breakpoint
-- Register the posting-event type (governed on /setup/posting-rules; the registry in posting-events.ts is
-- the code-side source of truth). Idempotent.
INSERT INTO posting_event_types (key, name, description) VALUES
  ('TAX.PROVISION', 'Current income-tax provision', 'Current CIT provision — Dr 5960 expense / Cr 2110 payable (ASC 740 / IAS 12, TAX-11)')
ON CONFLICT (key) DO NOTHING;
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
