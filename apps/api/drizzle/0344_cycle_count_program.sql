-- 0344_cycle_count_program — INV-3 / INV-17: governed cycle-count program with ABC classification + blind counts.
-- Ad-hoc stocktakes (INV-04) had no schedule and no risk-based cadence: everything was counted (or not) at
-- whim, so high-velocity / high-value items — the ones inventory-existence risk concentrates in — were not
-- necessarily counted more often. This turns counting into a governed PROGRAM:
--   • item_abc_class — a per-(tenant,item) ABC classification snapshot. Items are ranked by annual
--     consumption VALUE (Σ issued qty × unit cost) and Pareto-banded A (top ~80% of value) / B (next ~15%) /
--     C (last ~5%); class drives count frequency. Recomputed on demand (recompute writes computed_at/by).
--   • cycle_count_plans — the count CADENCE (days between counts) per class, per tenant (A frequent … C rare).
--     Seeded with defaults A=30 / B=90 / C=180 on first recompute; a tenant may tune each.
--   • cycle_count_tasks — a generated BLIND count task (due date, location/bin, status) linked to a Draft
--     stocktake (st_no). The counter is never shown the system/book qty — count entry is blind — and posting
--     reuses the existing stocktake variance maker-checker (INV-04 / SoD R11: counter ≠ poster) + the valued
--     GL adjustment path (inventory-ledger.postCountVariance). No posting logic is duplicated here.
-- All three tables are tenant-scoped: a leading (tenant_id, …) index + the CANONICAL 0232-form tenant_isolation
-- RLS policy (re-applied via the generic DO-loop below) + app_user grants. Idempotent; PGlite + Postgres alike.
CREATE TABLE IF NOT EXISTS item_abc_class (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  item_id text NOT NULL,
  class text NOT NULL,                                  -- 'A' | 'B' | 'C'
  annual_value numeric(18,4) NOT NULL DEFAULT 0,        -- Σ issued qty × unit cost over the window
  rank integer,                                         -- 1 = highest annual_value (ties broken by item_id)
  cum_pct numeric(9,4),                                 -- cumulative % of total value up to and incl. this item
  computed_at timestamptz DEFAULT now(),
  computed_by text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_item_abc_tenant_item ON item_abc_class (tenant_id, item_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_item_abc_tenant ON item_abc_class (tenant_id, class);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cycle_count_plans (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  class text NOT NULL,                                  -- 'A' | 'B' | 'C'
  cadence_days integer NOT NULL,                        -- days between counts for this class
  updated_at timestamptz DEFAULT now(),
  updated_by text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_ccplan_tenant_class ON cycle_count_plans (tenant_id, class);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ccplan_tenant ON cycle_count_plans (tenant_id, class);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cycle_count_tasks (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  task_no text NOT NULL,
  class text,                                           -- dominant class of the task's items
  location text,                                        -- location / bin scope (optional)
  due_date date,
  status text NOT NULL DEFAULT 'Open',                  -- Open | Counted | Cancelled (Posted derived from st_no)
  st_no text,                                           -- linked Draft stocktake document
  item_count integer NOT NULL DEFAULT 0,
  created_by text,
  created_at timestamptz DEFAULT now(),
  counted_by text,
  counted_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_cctask_no ON cycle_count_tasks (task_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cctask_tenant ON cycle_count_tasks (tenant_id, status);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the new tables
-- get RLS with the org-sharing clause. Idempotent; runs on PGlite + Postgres alike.
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
