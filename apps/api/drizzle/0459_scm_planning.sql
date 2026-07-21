-- 0459_scm_planning
-- docs/54 Phase 2 — Dynamic Supply Chain & Demand Forecasting (per-(branch,item) probabilistic planning
-- + perishable-aware order optimization). Seven tenant-scoped tables + one shared-master column.
--
-- Tenancy: every table below carries tenant_id and gets the CANONICAL 0232-form org-scoped
-- tenant_isolation policy from the trailing DO block, plus a LEADING (tenant_id, …) index (the
-- cutover:tenant-idx gate requires one). `items` is the SHARED master (no tenant_id, no RLS) — the
-- new shelf_life_days column is a physical property with a global default; every BEHAVIOURAL knob
-- (service level, costs, lead time, shelf-life override) is tenant-scoped in scm_item_policies.

-- Per-tenant planning settings (one row per tenant; NULL tenant_id = the system default row).
-- Shape mirrors receiving_settings (EXP-12) — read with get-or-default, written by upsert.
CREATE TABLE IF NOT EXISTS scm_settings (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  horizon_days integer NOT NULL DEFAULT 14,
  service_level numeric(5,4) NOT NULL DEFAULT 0.95,
  sample_paths integer NOT NULL DEFAULT 50,
  lookback_days integer NOT NULL DEFAULT 400,
  closed_weekdays jsonb NOT NULL DEFAULT '[]'::jsonb,   -- int[] 0=Sun..6=Sat, business TZ
  closures jsonb NOT NULL DEFAULT '[]'::jsonb,          -- [{date:'YYYY-MM-DD', branch_id?:number, reason?}]
  -- dine_in_orders has NO branch column, so restaurant demand is attributed to this outlet.
  -- Unset ⇒ it pools in the NULL-branch planning unit (surfaced as branch_null_share in run metrics).
  dine_in_branch_id bigint,
  spike_ewma_alpha numeric(5,4) NOT NULL DEFAULT 0.2,
  spike_z_threshold numeric(6,3) NOT NULL DEFAULT 3,
  spike_cusum_k numeric(6,3) NOT NULL DEFAULT 0.5,      -- slack, in sigma units
  spike_cusum_h numeric(6,3) NOT NULL DEFAULT 4,        -- decision threshold, in sigma units
  spike_min_qty numeric(18,4) NOT NULL DEFAULT 5,       -- volume floor: ignore 2 -> 7 unit noise
  spike_cooldown_hours integer NOT NULL DEFAULT 48,
  auto_replan boolean NOT NULL DEFAULT false,
  engine_enabled boolean NOT NULL DEFAULT true,         -- per-tenant opt-out even when the env is set
  updated_by text,
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_scm_settings_tenant ON scm_settings (tenant_id);
--> statement-breakpoint

-- Per-(branch,item) planning overrides. branch_id NULL = tenant-wide default for that item.
CREATE TABLE IF NOT EXISTS scm_item_policies (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  branch_id bigint,
  item_id text NOT NULL,
  service_level numeric(5,4),
  min_order_qty numeric(14,3),
  order_multiple numeric(14,3),
  max_stock_qty numeric(18,4),
  lead_time_days numeric(8,2),
  shelf_life_days integer,                              -- tenant override of items.shelf_life_days
  waste_cost_per_unit numeric(18,4),
  stockout_cost_per_unit numeric(18,4),
  planning_enabled boolean NOT NULL DEFAULT true,
  notes text,
  updated_by text,
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
-- coalesce(branch_id,0) so the tenant-wide default row (NULL branch) is unique too — plain UNIQUE
-- treats every NULL as distinct.
CREATE UNIQUE INDEX IF NOT EXISTS uq_scm_item_policy ON scm_item_policies (tenant_id, coalesce(branch_id, 0), item_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_scm_item_policies_tenant ON scm_item_policies (tenant_id, item_id);
--> statement-breakpoint

-- One row per planning run (nightly sweep / manual / spike replan).
CREATE TABLE IF NOT EXISTS scm_plan_runs (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  run_no text NOT NULL,                                 -- SCMR-YYYYMMDD-NNN
  run_date date NOT NULL,                               -- business day (Asia/Bangkok)
  scope text NOT NULL DEFAULT 'nightly',                -- nightly | manual | replan
  trigger_ref text,                                     -- replan: 'SPIKE:<id,...>'
  engine text NOT NULL DEFAULT 'fallback',              -- external | fallback
  engine_version text,
  status text NOT NULL DEFAULT 'Running',               -- Running | Completed | Failed
  branch_count integer,
  item_count integer,
  series_count integer,
  horizon_days integer,
  service_level numeric(5,4),
  request_digest text,                                  -- sha256 of the extraction payload (audit / repro)
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  created_by text,
  created_at timestamptz DEFAULT now(),
  completed_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_scm_plan_runs_tenant ON scm_plan_runs (tenant_id, run_date);
--> statement-breakpoint
-- Nightly idempotency: at most one non-failed nightly run per tenant per business day, enforced in
-- the DB so a duplicate job enqueue (multi-replica scheduler tick) cannot double-plan.
CREATE UNIQUE INDEX IF NOT EXISTS uq_scm_nightly_run ON scm_plan_runs (tenant_id, run_date)
  WHERE scope = 'nightly' AND status <> 'Failed';
--> statement-breakpoint

-- One row per (run, branch, item). A separate table rather than jsonb on the run: a 33-branch nightly
-- run yields ~10k series, which as one blob would be a multi-MB row read/written whole.
CREATE TABLE IF NOT EXISTS scm_demand_forecasts (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  run_id bigint NOT NULL REFERENCES scm_plan_runs(id),
  branch_id bigint,
  item_id text NOT NULL,
  level text NOT NULL DEFAULT 'ingredient',             -- ingredient | menu
  method text NOT NULL,                                 -- prophet | croston_sba | ... | fallback:<algo>
  horizon integer NOT NULL,
  start_date date NOT NULL,
  mean jsonb NOT NULL,                                  -- number[horizon]
  p10 jsonb,
  p50 jsonb,
  p90 jsonb,                                            -- NULL for point-forecast fallbacks
  data_days integer,
  wape numeric(10,4),
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_scm_forecasts_tenant ON scm_demand_forecasts (tenant_id, run_id, branch_id, item_id);
--> statement-breakpoint

-- Draft -> PendingApproval -> Approved -> Converted order plans (one per run x branch).
CREATE TABLE IF NOT EXISTS scm_order_plans (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  plan_no text NOT NULL,                                -- SCMP-YYYYMMDD-NNN
  run_id bigint REFERENCES scm_plan_runs(id),
  branch_id bigint,
  status text NOT NULL DEFAULT 'Draft',
  horizon_days integer,
  service_level numeric(5,4),
  est_total_cost numeric(18,2) NOT NULL DEFAULT '0',
  expected_waste_cost numeric(18,2),
  expected_stockout_cost numeric(18,2),
  expected_fill_rate numeric(6,4),
  engine text NOT NULL DEFAULT 'fallback',
  notes text,
  created_by text,
  created_at timestamptz DEFAULT now(),
  submitted_by text,
  submitted_at timestamptz,
  approved_by text,                                     -- checker - MUST differ from the maker
  approved_at timestamptz,
  reject_reason text,
  pr_no text,
  converted_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_scm_order_plan_no ON scm_order_plans (tenant_id, plan_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_scm_order_plans_tenant ON scm_order_plans (tenant_id, status);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS scm_order_plan_lines (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  plan_id bigint NOT NULL REFERENCES scm_order_plans(id),
  item_id text NOT NULL,
  item_description text,
  uom text,
  suggested_qty numeric(18,4) NOT NULL,
  final_qty numeric(18,4) NOT NULL,                     -- planner-editable while Draft
  unit_cost_est numeric(18,4) NOT NULL DEFAULT '0',
  vendor_id bigint,
  on_hand_qty numeric(18,4),
  expiring_qty numeric(18,4),
  in_transit_qty numeric(18,4),
  coverage_days numeric(8,2),
  stockout_risk_pct numeric(6,3),
  reason text NOT NULL DEFAULT 'optimize',              -- optimize | par_fallback | spike
  detail jsonb NOT NULL DEFAULT '{}'::jsonb             -- engine rationale, clamped flag, order split
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_scm_plan_line ON scm_order_plan_lines (tenant_id, plan_id, item_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_scm_plan_lines_tenant ON scm_order_plan_lines (tenant_id, plan_id);
--> statement-breakpoint

-- EWMA + CUSUM state per (branch,item) for the spike detector. last_day is the watermark, so a scan
-- at ANY cadence only folds in business days it has not already seen (idempotent re-runs).
CREATE TABLE IF NOT EXISTS scm_demand_baselines (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  branch_id bigint,
  item_id text NOT NULL,
  ewma_mean numeric(18,6) NOT NULL DEFAULT '0',
  ewma_var numeric(18,6) NOT NULL DEFAULT '0',
  cusum_pos numeric(18,6) NOT NULL DEFAULT '0',
  cusum_neg numeric(18,6) NOT NULL DEFAULT '0',
  obs_days integer NOT NULL DEFAULT 0,
  last_day date,
  last_spike_at timestamptz,                            -- cooldown anchor
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_scm_baseline ON scm_demand_baselines (tenant_id, coalesce(branch_id, 0), item_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_scm_baselines_tenant ON scm_demand_baselines (tenant_id, item_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS scm_spike_events (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  branch_id bigint,
  item_id text NOT NULL,
  day date NOT NULL,                                    -- business day the spike was measured on
  actual_qty numeric(18,4) NOT NULL,
  expected_qty numeric(18,4) NOT NULL,
  z_score numeric(10,4),
  cusum numeric(10,4),
  direction text NOT NULL DEFAULT 'up',                 -- up | down (down = over-stock warning)
  status text NOT NULL DEFAULT 'Open',                  -- Open | Replanned | Dismissed
  replan_run_id bigint,
  detected_at timestamptz DEFAULT now()
);
--> statement-breakpoint
-- Hard per-day dedupe: one viral evening yields ONE event, not forty (insert ON CONFLICT DO NOTHING).
CREATE UNIQUE INDEX IF NOT EXISTS uq_scm_spike_day ON scm_spike_events (tenant_id, coalesce(branch_id, 0), item_id, day);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_scm_spike_events_tenant ON scm_spike_events (tenant_id, status, detected_at);
--> statement-breakpoint

-- Shared master (`items` has no tenant_id => NO RLS loop needed for this column). Shelf life is a
-- physical property of the goods; a tenant that disagrees sets scm_item_policies.shelf_life_days.
ALTER TABLE items ADD COLUMN IF NOT EXISTS shelf_life_days integer;
--> statement-breakpoint

-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form). Idempotent.
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
