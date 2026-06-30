-- 0194_project_poc_revrec — over-time (percentage-of-completion) revenue recognition on projects (PPM
-- upgrade, control PROJ-09). A project can recognise revenue over time on a cost-to-cost basis instead of
-- only at billing: rev_method='poc' uses estimated_cost (the total estimated cost / EAC) to drive the
-- recognised %, accruing a contract asset (1265) / contract liability (2410). recognized_revenue tracks the
-- revenue recognised to date (distinct from recognized_cost, the WIP relieved to COGS). Existing projects
-- default to 'billing' (unchanged point-in-time recognition). No new table — columns on projects (RLS already on).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS rev_method text NOT NULL DEFAULT 'billing'; -- billing | poc
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN IF NOT EXISTS estimated_cost numeric(16,2) DEFAULT 0;       -- total estimated cost (EAC) for cost-to-cost POC
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN IF NOT EXISTS recognized_revenue numeric(16,2) DEFAULT 0;   -- revenue recognised to date (POC)
