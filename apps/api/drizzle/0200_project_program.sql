-- 0200_project_program — program (cross-project) grouping + project-level finish-to-start dependencies for the
-- program critical path (PMO-4, docs/23). `program_code` groups projects into a program; `depends_on_projects`
-- is a CSV of project_codes this project must follow (finish-to-start at the program level). Operational /
-- detective scheduling signal (rides PROJ-06) — non-posting, no GL impact. `projects` already carries
-- tenant_id + the RLS policy, so adding columns needs no RLS-loop re-run.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS program_code text;
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN IF NOT EXISTS depends_on_projects text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_project_program ON projects (program_code);
