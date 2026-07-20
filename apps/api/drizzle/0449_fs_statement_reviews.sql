-- 0449_fs_statement_reviews — FIN-4 GL-29: financial-statement issuance review & approval (maker-checker).
-- A preparer submits a period's statutory statement pack for review, capturing a snapshot + hash of the key
-- figures (assets/liabilities/equity/revenue/net income) as the "as-issued" record; a DIFFERENT user approves
-- it (self-approval → SOD_VIOLATION). Once approved, the formatted FS pack is stamped "Reviewed & approved by
-- X on DATE" instead of "unaudited"; if the live figures later drift from the approved snapshot the pack flags
-- "figures changed since approval — re-review required". Tenant-scoped (canonical 0232 RLS + a tenant-leading
-- index for the AUD-ARC-01 gate).
CREATE TABLE IF NOT EXISTS fs_statement_reviews (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  fiscal_year int NOT NULL,
  ledger text NOT NULL DEFAULT 'LEADING',
  industry text,                              -- layout industry it was prepared under (null = auto/own)
  status text NOT NULL DEFAULT 'PendingApproval',  -- PendingApproval | Approved
  total_assets numeric(18,2),
  total_liabilities numeric(18,2),
  total_equity numeric(18,2),
  revenue numeric(18,2),
  net_income numeric(18,2),
  figures_hash text NOT NULL,                 -- sha256 of the 5 rounded figures (tamper-evidence)
  prepared_by text,
  prepared_at timestamptz DEFAULT now(),
  approved_by text,
  approved_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_fs_statement_reviews_tenant ON fs_statement_reviews (tenant_id, fiscal_year, status);
--> statement-breakpoint
-- app_user grants + the CANONICAL org-scoped tenant_isolation policy (0232 form) for the new tenant table.
DO $$ DECLARE r record; BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' AND table_name='fs_statement_reviews' LOOP
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
