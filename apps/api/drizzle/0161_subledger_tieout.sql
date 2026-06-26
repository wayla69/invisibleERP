-- 0160_subledger_tieout: Sub-ledger tie-out / reconciliation (WS1.4, GL-14)
-- Reconciles GL control-account balances (1100 AR, 2000 AP, 1200 INV, 1500 FA) against the
-- sum of their sub-ledger detail, records the variance, and supports maker-checker certification.

CREATE TABLE IF NOT EXISTS subledger_tieout_runs (
  id                 BIGSERIAL PRIMARY KEY,
  tenant_id          BIGINT NOT NULL REFERENCES tenants(id),
  subledger          TEXT NOT NULL,            -- 'AR' | 'AP' | 'INV' | 'FA'
  control_account    TEXT NOT NULL,            -- e.g. '1100'
  as_of_date         TEXT NOT NULL,            -- bizYmdDash
  gl_balance         NUMERIC NOT NULL,
  subledger_balance  NUMERIC NOT NULL,
  variance           NUMERIC NOT NULL,         -- gl - subledger
  status             TEXT NOT NULL DEFAULT 'Open', -- 'Open' | 'Matched' | 'Variance' | 'Certified'
  detail             JSONB,
  run_by             TEXT NOT NULL,
  certified_by       TEXT,
  certified_at       TIMESTAMPTZ,
  note               TEXT,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_subledger_tieout
  ON subledger_tieout_runs(tenant_id, subledger, as_of_date);

-- RLS — tenant isolation (standard policy)
ALTER TABLE subledger_tieout_runs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='subledger_tieout_runs' AND policyname='tenant_isolation_subledger_tieout'
  ) THEN
    CREATE POLICY tenant_isolation_subledger_tieout ON subledger_tieout_runs
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::BIGINT);
  END IF;
END $$;
