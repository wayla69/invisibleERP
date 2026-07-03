-- 0238_tenant_idx_boq_commit — add the tenant-leading indexes the AUD-ARC-01 tenant-index guard requires on
-- the project material-control tables. RLS puts a tenant_id predicate on every query, so each tenant-scoped
-- table MUST have an index whose LEADING column is tenant_id. project_boq / project_boq_lines (migration
-- 0236) and project_commitments (0237) shipped without one — this backfills all three (idempotent).
CREATE INDEX IF NOT EXISTS idx_boq_tenant ON project_boq (tenant_id, project_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_boq_line_tenant ON project_boq_lines (tenant_id, boq_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_commit_tenant ON project_commitments (tenant_id, boq_line_id);
