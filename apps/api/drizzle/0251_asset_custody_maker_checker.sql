-- FA-11 asset custody-change maker-checker + asset audit-by-scan + offline scan idempotency.
--   * asset_scan_requests — a custody MOVE (location/holder change) becomes a PendingApproval request that a
--     DIFFERENT user must approve before the register moves (no GL effect). Confirming the current location
--     needs no approval (logged as a 'Scan Verify' movement).
--   * asset_audits / asset_audit_scans — physical count by scan; scans classified Found/Misplaced/Unknown,
--     reconciliation adds Missing; closing raises custody-change requests for the misplaced assets.
--   * asset_audit_scans.client_uuid + scan_lines.client_uuid — offline idempotency (replay-safe).

CREATE TABLE IF NOT EXISTS asset_scan_requests (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  req_no text NOT NULL,
  asset_id bigint REFERENCES fixed_assets(id),
  asset_no text NOT NULL,
  from_location text,
  to_location text,
  from_assigned_to text,
  to_assigned_to text,
  note text,
  source text NOT NULL DEFAULT 'scan',
  audit_no text,
  status text NOT NULL DEFAULT 'PendingApproval',
  requested_by text,
  requested_at timestamptz DEFAULT now(),
  approved_by text,
  approved_at timestamptz,
  reject_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_scan_req_no ON asset_scan_requests (tenant_id, req_no);
CREATE INDEX IF NOT EXISTS idx_asset_scan_req_status ON asset_scan_requests (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_asset_scan_req_asset ON asset_scan_requests (asset_no);

CREATE TABLE IF NOT EXISTS asset_audits (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  audit_no text NOT NULL,
  location text,
  status text NOT NULL DEFAULT 'Open',
  expected_count integer NOT NULL DEFAULT 0,
  created_by text,
  created_at timestamptz DEFAULT now(),
  closed_at timestamptz,
  closed_by text
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_audit_no ON asset_audits (tenant_id, audit_no);
CREATE INDEX IF NOT EXISTS idx_asset_audit_status ON asset_audits (tenant_id, status);

CREATE TABLE IF NOT EXISTS asset_audit_scans (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  audit_no text NOT NULL,
  asset_no text NOT NULL,
  result text NOT NULL,
  register_location text,
  client_uuid text,
  scanned_by text,
  scanned_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_audit_scan_uuid ON asset_audit_scans (tenant_id, audit_no, client_uuid);
CREATE INDEX IF NOT EXISTS idx_asset_audit_scan_audit ON asset_audit_scans (audit_no);

-- Offline idempotency for the inventory mobile-scan session (scan_lines is keyed by session_no, not tenant).
ALTER TABLE scan_lines ADD COLUMN IF NOT EXISTS client_uuid text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_scan_line_uuid ON scan_lines (session_no, client_uuid);

-- Re-run the RLS loop so the new tenant_id tables are isolation-scoped. Structure from 0137 (GRANTs +
-- ENABLE/FORCE), but the CANONICAL org-clause policy body from 0232 (a plain body here would silently drop
-- cross-account org sharing on every data table, since this migration runs after 0232). Idempotent.
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
