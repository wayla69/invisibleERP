-- 0187_project_task_dependencies — task predecessors for scheduling (PPM roadmap P4, docs/19).
-- project_tasks.depends_on holds a CSV of predecessor task ids (the Gantt/critical-path inputs). Nullable and
-- backward-compatible; operational/non-financial. No RLS change (project_tasks already tenant-scoped).
-- (Earned-value metrics — PV/EV/AC → CPI/SPI — are computed on read from tasks + project actuals; no schema.)
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS depends_on text;
