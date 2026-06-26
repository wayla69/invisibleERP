-- 0155_coa_master: Chart of Accounts as master data (WS1.1)
-- Adds account_groups table and extends accounts with control/hierarchy columns.

CREATE TABLE IF NOT EXISTS account_groups (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT REFERENCES tenants(id),
  code            TEXT NOT NULL,
  name_th         TEXT NOT NULL,
  name_en         TEXT NOT NULL,
  type            account_type NOT NULL,
  parent_group_id BIGINT REFERENCES account_groups(id),
  sort_order      INT DEFAULT 0,
  active          BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_groups
  ON account_groups (COALESCE(tenant_id, 0), code);

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS name_th           TEXT,
  ADD COLUMN IF NOT EXISTS account_group_id  BIGINT REFERENCES account_groups(id),
  ADD COLUMN IF NOT EXISTS is_control        BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS control_subledger TEXT,
  ADD COLUMN IF NOT EXISTS normal_balance    TEXT DEFAULT 'D',
  ADD COLUMN IF NOT EXISTS is_postable       BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS require_dimension JSONB,
  ADD COLUMN IF NOT EXISTS effective_from    DATE,
  ADD COLUMN IF NOT EXISTS effective_to      DATE;

-- Seed control flags on existing accounts
UPDATE accounts SET is_control = TRUE, control_subledger = 'AR'  WHERE code = '1100';
UPDATE accounts SET is_control = TRUE, control_subledger = 'AP'  WHERE code = '2000';
UPDATE accounts SET is_control = TRUE, control_subledger = 'INV' WHERE code = '1200';
UPDATE accounts SET is_control = TRUE, control_subledger = 'FA'  WHERE code = '1500';

-- Seed normal_balance (Liability/Equity/Revenue = Credit normal)
UPDATE accounts SET normal_balance = 'C'
WHERE type IN ('Liability', 'Equity', 'Revenue');

-- RLS for account_groups (tenant_id nullable: NULL = global template visible to all)
ALTER TABLE account_groups ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='account_groups' AND policyname='tenant_isolation_account_groups'
  ) THEN
    CREATE POLICY tenant_isolation_account_groups ON account_groups
      USING (tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::BIGINT);
  END IF;
END $$;
