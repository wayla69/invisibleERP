-- 0190_project_task_raci — RACI accountability on WBS tasks (PPM next-level B3, docs/20). Adds the four RACI
-- roles to project_tasks: accountable (the single owner — exactly one person answerable), responsible (CSV of
-- who does the work), consulted + informed (CSV). `assignee` (free text) stays for back-compat. project_tasks
-- already carries tenant_id + the RLS policy, so adding columns needs no RLS-loop re-run.
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS accountable text;
--> statement-breakpoint
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS responsible text;   -- CSV of responsible people
--> statement-breakpoint
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS consulted text;     -- CSV of consulted people
--> statement-breakpoint
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS informed text;      -- CSV of informed people
