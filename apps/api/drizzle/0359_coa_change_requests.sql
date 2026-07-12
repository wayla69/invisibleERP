-- 0359: COA follow-up C — canonical Chart-of-Accounts maker-checker (GL-27).
-- A canonical account create/update/deactivate is staged here and applied only on a DIFFERENT
-- Admin's approval; when the system has exactly ONE active Admin the change applies immediately
-- and the row records the exception (status 'AutoApplied') — owner decision 2026-07-12.
-- PLATFORM-level table (the canonical chart is global): the company column is `created_tenant_id`
-- (context only, NOT `tenant_id`) so the generic RLS loop and the tenant-idx gate skip it.
CREATE TABLE IF NOT EXISTS coa_change_requests (
  id bigserial PRIMARY KEY,
  action text NOT NULL,                                -- 'create' | 'update' | 'deactivate'
  account_code text NOT NULL,
  payload jsonb,                                       -- the requested dto (create fields / update patch)
  before jsonb,                                        -- snapshot of the account for update/deactivate (audit)
  status text NOT NULL DEFAULT 'PendingApproval',      -- PendingApproval | Approved | Rejected | AutoApplied
  reason text,                                         -- reject reason
  created_by text,
  created_tenant_id bigint REFERENCES tenants(id),     -- requester's company context (informational)
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coa_change_requests_status ON coa_change_requests(status, id);

-- Grant to the non-superuser runtime role (mirrors 0234/0247 platform tables).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, INSERT, UPDATE ON coa_change_requests TO app_user;
    GRANT USAGE, SELECT ON SEQUENCE coa_change_requests_id_seq TO app_user;
  END IF;
END $$;
