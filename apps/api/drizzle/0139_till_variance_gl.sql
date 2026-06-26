-- POS-01: till-close cash over/short → GL posting + maker-checker.
-- closeTill posts the variance to GL (5830 Cash Over/Short ↔ 1000 Cash). A variance over the
-- materiality threshold posts a DRAFT journal entry and waits for a DIFFERENT user to approve
-- (reuses the GL-05 ledger maker-checker), so a cashier cannot self-clear a material discrepancy.
ALTER TABLE till_sessions
  ADD COLUMN IF NOT EXISTS variance_journal_no text,
  ADD COLUMN IF NOT EXISTS variance_status text NOT NULL DEFAULT 'NotRequired',
  ADD COLUMN IF NOT EXISTS variance_approved_by text,
  ADD COLUMN IF NOT EXISTS variance_approved_at timestamptz;
--> statement-breakpoint
-- Cash Over/Short control account (global chart of accounts) for existing tenants.
-- Fresh installs also get this via LedgerService.seedChartOfAccounts().
INSERT INTO accounts (code, name, type)
  VALUES ('5830', 'Cash Over/Short', 'Expense')
  ON CONFLICT (code) DO NOTHING;
