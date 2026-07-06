-- Sensitive master-data bulk-import maker-checker (maker-checker audit gaps G5/G7/G8). The registry-driven
-- import engine can change fraud-relevant master-data fields in bulk — customer/vendor credit limits (R09),
-- vendor payment terms (R02), price-list prices and promotion discounts (R10). A batch that touches any such
-- SENSITIVE column is now STAGED here as PendingApproval (nothing is written to the entity table) and applied
-- only when a DIFFERENT user approves it. Non-sensitive imports (items, contacts, tax codes, …) still commit
-- directly. The raw rows are held as JSON until approval. Tenant-scoped; RLS re-applied below.
CREATE TABLE IF NOT EXISTS masterdata_import_batches (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  req_no text NOT NULL,
  entity_key text NOT NULL,
  mode text NOT NULL,                       -- append | replace
  rows text NOT NULL,                       -- JSON array of the header-keyed import rows
  row_count integer NOT NULL DEFAULT 0,
  sensitive_fields text,                    -- comma-joined sensitive headers that triggered staging
  status text NOT NULL DEFAULT 'PendingApproval', -- PendingApproval | Approved | Rejected
  result text,                              -- JSON import result recorded on approval
  requested_by text,
  requested_at timestamptz DEFAULT now(),
  approved_by text,                         -- checker — must differ from requester
  approved_at timestamptz,
  reject_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_md_import_batch_no ON masterdata_import_batches (tenant_id, req_no);
CREATE INDEX IF NOT EXISTS idx_md_import_batch_status ON masterdata_import_batches (tenant_id, status);

-- Re-run the RLS loop so the new tenant_id table is isolation-scoped. GRANT/ENABLE/FORCE structure from
-- 0137, CANONICAL org-clause policy body from 0232 (a plain body here would silently drop cross-account org
-- sharing on every data table, since this migration runs after 0232). Idempotent.
DO $$
DECLARE r record;
BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'tenant_id'
  LOOP
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
