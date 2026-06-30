-- REC-03 — per-period intercompany reconciliation sign-off gate.
-- A preparer reconciles the group's IC balances (Due-From 1150 vs Due-To 2150) for a period and signs
-- (Prepared); an independent approver (SoD) approves (Approved). consolidation.runConsolidation() is gated on
-- an Approved row for (group, period). Owned by the HQ/group tenant; tenant-isolated via RLS.
CREATE TABLE IF NOT EXISTS ic_recon_periods (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT REFERENCES tenants(id),
  group_id        BIGINT NOT NULL,
  period          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'Open',  -- Open | Prepared | Approved | Rejected
  total_due_from  NUMERIC(18,4) DEFAULT 0,
  total_due_to    NUMERIC(18,4) DEFAULT 0,
  eliminates      BOOLEAN DEFAULT FALSE,
  unmatched_count INTEGER DEFAULT 0,
  prepared_by     TEXT,
  prepared_at     TIMESTAMPTZ,
  approved_by     TEXT,
  approved_at     TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ic_recon_group ON ic_recon_periods(group_id, period);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ic_recon_period ON ic_recon_periods(tenant_id, group_id, period);

-- RLS — tenant isolation with the app.bypass_rls escape so an HQ/Admin (bypass) can write the group-level
-- sign-off row while reading across member tenants (mirrors 0171_consolidation). Idempotent.
ALTER TABLE ic_recon_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE ic_recon_periods FORCE ROW LEVEL SECURITY;
DO $ic_recon_rls$ BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ic_recon_periods TO app_user';
EXCEPTION WHEN undefined_object THEN NULL; END $ic_recon_rls$;
DROP POLICY IF EXISTS tenant_isolation ON ic_recon_periods;
CREATE POLICY tenant_isolation ON ic_recon_periods
  USING (coalesce(current_setting('app.bypass_rls', true), '') = 'on'
      OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (coalesce(current_setting('app.bypass_rls', true), '') = 'on'
      OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
