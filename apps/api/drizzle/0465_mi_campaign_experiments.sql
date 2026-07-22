-- 0465_mi_campaign_experiments
-- docs/60 Phase 3 — Closed-loop Measurement (campaign incrementality). When a pushed mi_segment is
-- activated, the eligible members are split ONCE into a TREATMENT arm (contacted) and a randomised
-- HOLDOUT CONTROL arm (deliberately NOT contacted), fixed at send time and immutable. After a
-- measurement window the lift = treatment-per-head vs control-per-head on real POS revenue (read through
-- the owning module's read API — never a cross-domain join) proves the campaign CAUSED sales.
--
-- Tenancy: both tables carry tenant_id → the canonical 0232-form org RLS policy (trailing DO block) +
-- a LEADING (tenant_id, …) index. Read/measurement model — no GL posting.

-- Experiment header: one per activation-under-measurement.
CREATE TABLE IF NOT EXISTS mi_campaign_experiments (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  experiment_no text NOT NULL,                         -- MIX-YYYYMMDD-NNN
  segment text NOT NULL,                               -- the mi_segment measured
  campaign_id bigint,                                  -- the ERP campaign created for the treatment arm (optional)
  control_pct numeric(5,4) NOT NULL DEFAULT 0.2,       -- holdout fraction [0,1)
  window_days integer NOT NULL DEFAULT 14,             -- measurement window length
  treatment_count integer NOT NULL DEFAULT 0,
  control_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'Running',              -- Running | Measured
  started_at timestamptz DEFAULT now(),
  measure_after timestamptz,                           -- started_at + window_days (earliest measurement)
  -- lift results (populated at measurement)
  treatment_revenue numeric(14,2),
  control_revenue numeric(14,2),
  treatment_per_head numeric(14,2),
  control_per_head numeric(14,2),
  incremental_revenue numeric(14,2),                   -- (treat_per_head - ctrl_per_head) * treatment_count
  lift_pct numeric(8,2),                               -- (treat_per_head - ctrl_per_head) / ctrl_per_head * 100
  measured_at timestamptz,
  measured_by text,
  created_by text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mi_experiments_tenant ON mi_campaign_experiments (tenant_id, status, started_at DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ux_mi_experiments_no ON mi_campaign_experiments (tenant_id, experiment_no);
--> statement-breakpoint

-- Arm membership: one row per (experiment, member), FIXED at creation, never re-randomised. The control
-- arm's members are the audit evidence they were never contacted.
CREATE TABLE IF NOT EXISTS mi_experiment_arms (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  experiment_id bigint NOT NULL REFERENCES mi_campaign_experiments(id),
  member_id bigint NOT NULL,
  arm text NOT NULL,                                   -- treatment | control
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ux_mi_arms_member ON mi_experiment_arms (tenant_id, experiment_id, member_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mi_arms_tenant ON mi_experiment_arms (tenant_id, experiment_id, arm);
--> statement-breakpoint

-- Explicit member-list audience for the treatment arm (a campaign contacts ONLY these members, so the
-- control arm is structurally never contacted). Nullable; only read when audience='members'.
ALTER TABLE loyalty_campaigns ADD COLUMN IF NOT EXISTS member_ids jsonb;
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
