-- 0186_timesheet_project_labor — link HCM timesheets to project labor with a maker-checker approval (PPM P3).
-- An approved timesheet (approver ≠ submitter — PROJ-04) posts its labor cost (hours × employee hourly rate)
-- into the target project's WIP via the existing PRJ-COST path. All columns are nullable/defaulted and
-- backward-compatible — existing timesheets keep working (status defaults Pending; no project → no posting).
-- timesheets already carries tenant_id and is RLS-scoped; adding columns does not change the policy.
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS project_id bigint;
--> statement-breakpoint
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS task_id bigint;
--> statement-breakpoint
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS billable boolean DEFAULT true;
--> statement-breakpoint
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'Pending';
--> statement-breakpoint
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS submitted_by text;
--> statement-breakpoint
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS approved_by text;
--> statement-breakpoint
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS approved_at timestamptz;
--> statement-breakpoint
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS entry_no text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ts_project ON timesheets (project_id);
