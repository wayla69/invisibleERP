-- 0266 — G13 (maker-checker audit): staff-initiated P2P loyalty-point transfers over the approval threshold
-- are now dual-controlled. A staff transfer above the threshold moves point-value (a TFRS-15 liability) to
-- another member — a self-enrichment vector (SoD R15/R16) — so it is STAGED here as PendingApproval (no
-- points move) and executed only when a DISTINCT approver releases it (403 SOD_VIOLATION on self-approval).
-- Sub-threshold transfers still move immediately (fast counter, mirrors the gift-card threshold gate).
-- Tenant-scoped (tenant_id is the owning shop) → RLS re-applied below.
CREATE TABLE IF NOT EXISTS pending_point_transfers (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  req_no text NOT NULL,
  from_member_id bigint NOT NULL REFERENCES pos_members(id),
  to_member_id bigint NOT NULL REFERENCES pos_members(id),
  points numeric NOT NULL,
  note text,
  status text NOT NULL DEFAULT 'PendingApproval', -- PendingApproval | Approved | Rejected
  requested_by text,
  requested_at timestamptz DEFAULT now(),
  approved_by text,                               -- checker — must differ from requester
  approved_at timestamptz,
  reject_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_point_transfer_no ON pending_point_transfers (tenant_id, req_no);
CREATE INDEX IF NOT EXISTS idx_pending_point_transfer_status ON pending_point_transfers (tenant_id, status);

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
