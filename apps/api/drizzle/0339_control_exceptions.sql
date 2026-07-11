-- 0339 — GRC-4 (GOV-02): Control-Exception Disposition + KCI. Turns the continuous-controls monitor
-- (0092 control_findings) from a review list into a MANAGED continuous-monitoring program: every exception
-- carries the RCM control it relates to (rcm_ref), an accountable remediation owner + due date, a documented
-- root cause, and a disposition tracked to closure (open → investigating → remediated | accepted |
-- false_positive) with who/when closed it. Additive columns only — the existing scanner keeps working
-- (existing findings default disposition='open'). control_findings already carries tenant_id + the canonical
-- RLS policy (0092); no new tenant table, so no RLS loop is required — only the disposition columns + a
-- KCI roll-up index. Idempotent; runs on PGlite + Postgres alike.
ALTER TABLE control_findings ADD COLUMN IF NOT EXISTS rcm_ref text;
--> statement-breakpoint
ALTER TABLE control_findings ADD COLUMN IF NOT EXISTS disposition text NOT NULL DEFAULT 'open';
--> statement-breakpoint
ALTER TABLE control_findings ADD COLUMN IF NOT EXISTS owner text;
--> statement-breakpoint
ALTER TABLE control_findings ADD COLUMN IF NOT EXISTS due_date date;
--> statement-breakpoint
ALTER TABLE control_findings ADD COLUMN IF NOT EXISTS root_cause text;
--> statement-breakpoint
ALTER TABLE control_findings ADD COLUMN IF NOT EXISTS remediated_by text;
--> statement-breakpoint
ALTER TABLE control_findings ADD COLUMN IF NOT EXISTS remediated_at timestamptz;
--> statement-breakpoint
-- KCI roll-up reads open exceptions per (tenant, disposition, control_key); a leading tenant_id index
-- already exists (uq_control_findings_fp / idx_control_findings_scope), this one serves the disposition cut.
CREATE INDEX IF NOT EXISTS idx_control_findings_disp ON control_findings (tenant_id, disposition);
