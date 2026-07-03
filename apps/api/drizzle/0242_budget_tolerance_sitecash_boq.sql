-- 0242_budget_tolerance_sitecash_boq — Project material control FU1 (docs/32). (a) An over-budget TOLERANCE
-- on the project: a material draw may exceed a BoQ line by up to projects.budget_tolerance_pct % of the line
-- budget before it needs the over-budget approval (0 = strict). (b) SITE CASH CONSUMES BUDGET: advances /
-- petty-cash / expense claims gain a boq_line_id so a project-tagged cash spend books a commitment against a
-- BoQ line (reducing its remaining). Column-adds only (projects already has RLS + a tenant-leading index; the
-- three cash tables already carry tenant_id + tenant-leading indexes).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_tolerance_pct numeric(6,3) NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE employee_advances ADD COLUMN IF NOT EXISTS boq_line_id bigint;
--> statement-breakpoint
ALTER TABLE expense_requests ADD COLUMN IF NOT EXISTS boq_line_id bigint;
--> statement-breakpoint
ALTER TABLE expense_claims ADD COLUMN IF NOT EXISTS boq_line_id bigint;
