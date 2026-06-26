-- 0162_close_runs: Hard period close + close checklist (WS2.1, GL-15/GL-16)
-- A close_runs record per (tenant, period) drives a checklist of close_run_steps. The period can only be
-- Locked once all REQUIRED steps are Done, and the locker must differ from the starter (maker-checker SoD).
-- Locking writes 'Locked' into fiscal_periods.status — the new hard gate in postEntry that nothing bypasses
-- except the system year-end closing entry (source='CLOSE').

-- Extend the period_status enum with the hard-close 'Locked' state (idempotent, PG 12+).
ALTER TYPE "period_status" ADD VALUE IF NOT EXISTS 'Locked';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS close_runs (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    BIGINT NOT NULL REFERENCES tenants(id),
  period       TEXT NOT NULL,                     -- 'YYYY-MM'
  status       TEXT NOT NULL DEFAULT 'Open',      -- 'Open' | 'InProgress' | 'ReadyToLock' | 'Locked'
  started_by   TEXT NOT NULL,
  locked_by    TEXT,
  locked_at    TIMESTAMPTZ,
  note         TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_close_runs ON close_runs(tenant_id, period);

CREATE TABLE IF NOT EXISTS close_run_steps (
  id            BIGSERIAL PRIMARY KEY,
  close_run_id  BIGINT NOT NULL REFERENCES close_runs(id),
  tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
  step_key      TEXT NOT NULL,                    -- 'subledger_tieout' | 'bank_rec' | 'depreciation' | 'recurring' | 'fx_reval' | 'trial_balance_review'
  title         TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  required      BOOLEAN NOT NULL DEFAULT TRUE,
  status        TEXT NOT NULL DEFAULT 'Pending',  -- 'Pending' | 'Done' | 'Skipped'
  completed_by  TEXT,
  completed_at  TIMESTAMPTZ,
  detail        JSONB
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_close_run_steps ON close_run_steps(close_run_id, step_key);

-- RLS — tenant isolation (standard policy)
ALTER TABLE close_runs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='close_runs' AND policyname='tenant_isolation_close_runs'
  ) THEN
    CREATE POLICY tenant_isolation_close_runs ON close_runs
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::BIGINT);
  END IF;
END $$;

ALTER TABLE close_run_steps ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='close_run_steps' AND policyname='tenant_isolation_close_run_steps'
  ) THEN
    CREATE POLICY tenant_isolation_close_run_steps ON close_run_steps
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::BIGINT);
  END IF;
END $$;
