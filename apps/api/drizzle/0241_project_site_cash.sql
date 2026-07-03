-- 0241_project_site_cash — Project material control M4 (docs/32, PROJ-14). Adds a nullable project dimension
-- to the three site-cash entities so advances, expense reimbursement claims, and petty-cash requests can be
-- managed against a project (traceable on the project, tagged on the GL expense line). Column-add only — all
-- three tables already carry tenant_id + a tenant-leading index (no RLS / tenant-idx change needed).
ALTER TABLE employee_advances ADD COLUMN IF NOT EXISTS project_id bigint;
--> statement-breakpoint
ALTER TABLE expense_claims ADD COLUMN IF NOT EXISTS project_id bigint;
--> statement-breakpoint
ALTER TABLE expense_requests ADD COLUMN IF NOT EXISTS project_id bigint;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_adv_project ON employee_advances (project_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_expense_claim_project ON expense_claims (project_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_expense_req_project ON expense_requests (project_id);
