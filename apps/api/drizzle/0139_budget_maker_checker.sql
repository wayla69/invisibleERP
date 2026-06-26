-- 0139 — Budget maker-checker (BUD-01). A budget line was fire-and-forget: one person upserted any amount and
-- it immediately drove the budget-vs-actual variance report (the basis for performance/spend decisions). Now an
-- upserted budget is PendingApproval and is EXCLUDED from budget-vs-actual until a DIFFERENT user approves it.
-- status DEFAULT 'Approved' keeps every existing row + any direct seed usable with no behaviour change; only the
-- POST /api/ledger/budgets upsert path lands rows as PendingApproval.
ALTER TABLE budgets ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'Approved'; -- Approved | PendingApproval | Rejected
ALTER TABLE budgets ADD COLUMN IF NOT EXISTS requested_by text;
ALTER TABLE budgets ADD COLUMN IF NOT EXISTS approved_by text;  -- checker — must differ from requested_by
ALTER TABLE budgets ADD COLUMN IF NOT EXISTS approved_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_budget_status ON budgets (tenant_id, status);
