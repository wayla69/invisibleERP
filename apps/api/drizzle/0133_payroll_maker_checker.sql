-- 0133 — Payroll maker-checker (PAY-03). A payroll run now posts its GL entry as a DRAFT (excluded from
-- balances) and the run record is 'PendingApproval'; a DIFFERENT user must approve before the JE becomes
-- effective (segregation of duties — reuses the GL-05 ledger approval / SoD). Records who/when approved.
ALTER TABLE payruns ADD COLUMN IF NOT EXISTS approved_by text;
ALTER TABLE payruns ADD COLUMN IF NOT EXISTS approved_at timestamptz;
