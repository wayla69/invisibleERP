-- 0183_project_customer_link — link a project to its customer-of-record + the CRM opportunity it came from (CRM-WL).
-- A WON opportunity (crm_opportunities) can convert into a project; we stamp customer_no (→ customer_master) and
-- crm_opp_no (→ crm_opportunities.opp_no) so project margin traces back to the deal that produced it, and a given
-- opportunity converts to at most one project (idempotency keyed on crm_opp_no). Both columns are nullable and
-- backward-compatible — existing projects and the free-text customer_name are untouched. No RLS change: the
-- projects table is already tenant-scoped/RLS-enabled; adding columns does not alter the tenant_isolation policy.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS customer_no text;
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN IF NOT EXISTS crm_opp_no text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_project_crm_opp ON projects(crm_opp_no);
