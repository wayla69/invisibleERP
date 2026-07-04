-- 0236_project_boq — Project material control M0 (docs/32). Adds the Bill of Quantities (BoQ) as the
-- project's measured-works requirement & budget baseline, and dimensions procurement (PR/PO/GR) by project +
-- BoQ line so material can be committed/received against a project. Structure only — no GL/control change in
-- M0 (M1 adds the commitment ledger + PROJ-12 enforcement on top of these tables).
CREATE TABLE IF NOT EXISTS project_boq (
  id bigserial PRIMARY KEY,
  project_id bigint NOT NULL REFERENCES projects(id),
  tenant_id bigint REFERENCES tenants(id),
  boq_no text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  title text,
  status text NOT NULL DEFAULT 'draft',            -- draft | approved | locked
  budget_total numeric(16,2) NOT NULL DEFAULT 0,   -- Σ line budgets (snapshot on approve)
  approved_by text,
  approved_at timestamptz,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_boq_project ON project_boq (project_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS project_boq_lines (
  id bigserial PRIMARY KEY,
  boq_id bigint NOT NULL REFERENCES project_boq(id),
  project_id bigint NOT NULL REFERENCES projects(id),
  tenant_id bigint REFERENCES tenants(id),
  line_no integer NOT NULL DEFAULT 0,
  category text NOT NULL DEFAULT 'material',        -- material | labor | subcon | other
  item_no text,
  task_id bigint,
  wbs_code text,
  description text,
  uom text,
  budget_qty numeric(18,4) NOT NULL DEFAULT 0,
  rate numeric(16,2) NOT NULL DEFAULT 0,
  budget_amount numeric(16,2) NOT NULL DEFAULT 0,   -- = budget_qty × rate
  remeasured_qty numeric(18,4),
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_boq_line_boq ON project_boq_lines (boq_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_boq_line_project ON project_boq_lines (project_id);
--> statement-breakpoint
-- Project dimension on procurement (nullable → non-project buys unaffected). purchase_* have no tenant_id
-- (company-wide documents), so these columns don't participate in tenant RLS — they only tag the project.
ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS project_id bigint;
--> statement-breakpoint
ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS boq_line_id bigint;
--> statement-breakpoint
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS project_id bigint;
--> statement-breakpoint
ALTER TABLE po_items ADD COLUMN IF NOT EXISTS project_id bigint;
--> statement-breakpoint
ALTER TABLE po_items ADD COLUMN IF NOT EXISTS boq_line_id bigint;
--> statement-breakpoint
ALTER TABLE goods_receipts ADD COLUMN IF NOT EXISTS project_id bigint;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_po_project ON purchase_orders (project_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pr_project ON purchase_requests (project_id);
--> statement-breakpoint
-- app_user grants for the new tables + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form)
-- to every tenant_id table so project_boq / project_boq_lines get RLS with the org-sharing clause (NOT the
-- plain body — see CLAUDE.md tenancy note). Idempotent. Runs on PGlite + Postgres alike.
DO $$ DECLARE r record; BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I'
      || ' USING (coalesce(current_setting(''app.bypass_rls'', true), '''') = ''on'''
      || '        OR tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint'
      || '        OR (nullif(current_setting(''app.org_id'', true), '''') IS NOT NULL'
      || '            AND tenant_id IN (SELECT id FROM tenants WHERE org_id = nullif(current_setting(''app.org_id'', true), '''')::bigint)))'
      || ' WITH CHECK (coalesce(current_setting(''app.bypass_rls'', true), '''') = ''on'''
      || '        OR tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint'
      || '        OR (nullif(current_setting(''app.org_id'', true), '''') IS NOT NULL'
      || '            AND tenant_id IN (SELECT id FROM tenants WHERE org_id = nullif(current_setting(''app.org_id'', true), '''')::bigint)))',
      r.table_name);
  END LOOP;
END $$;
