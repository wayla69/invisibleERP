-- 0476 — Realized-outcome measurement for NBA journeys (MKT-22) + churn-save runs (MKT-24), docs/61.
-- Closes the measurement loop: after the window, treatment-vs-control REAL POS revenue (the MKT-19 lift
-- discipline) is stored on the journey/run. mi_journeys / mi_save_runs already carry tenant_id + the
-- canonical org RLS policy + grants (0471/0473) — adding nullable columns needs no RLS/GRANT change
-- (0467 pattern). NEW table mi_save_targets persists each sweep's per-member holdout arms (the control
-- arm is never contacted and exists nowhere else, so past runs were previously unmeasurable).

ALTER TABLE mi_journeys ADD COLUMN IF NOT EXISTS measure_after timestamptz;
--> statement-breakpoint
ALTER TABLE mi_journeys ADD COLUMN IF NOT EXISTS treatment_revenue numeric(16,2);
--> statement-breakpoint
ALTER TABLE mi_journeys ADD COLUMN IF NOT EXISTS control_revenue numeric(16,2);
--> statement-breakpoint
ALTER TABLE mi_journeys ADD COLUMN IF NOT EXISTS treatment_per_head numeric(16,2);
--> statement-breakpoint
ALTER TABLE mi_journeys ADD COLUMN IF NOT EXISTS control_per_head numeric(16,2);
--> statement-breakpoint
ALTER TABLE mi_journeys ADD COLUMN IF NOT EXISTS realized_lift_pct numeric(10,2);
--> statement-breakpoint
ALTER TABLE mi_journeys ADD COLUMN IF NOT EXISTS incremental_revenue numeric(16,2);
--> statement-breakpoint
ALTER TABLE mi_journeys ADD COLUMN IF NOT EXISTS measured_at timestamptz;
--> statement-breakpoint
ALTER TABLE mi_journeys ADD COLUMN IF NOT EXISTS measured_by text;
--> statement-breakpoint

ALTER TABLE mi_save_runs ADD COLUMN IF NOT EXISTS measure_after timestamptz;
--> statement-breakpoint
ALTER TABLE mi_save_runs ADD COLUMN IF NOT EXISTS treatment_revenue numeric(16,2);
--> statement-breakpoint
ALTER TABLE mi_save_runs ADD COLUMN IF NOT EXISTS control_revenue numeric(16,2);
--> statement-breakpoint
ALTER TABLE mi_save_runs ADD COLUMN IF NOT EXISTS treatment_per_head numeric(16,2);
--> statement-breakpoint
ALTER TABLE mi_save_runs ADD COLUMN IF NOT EXISTS control_per_head numeric(16,2);
--> statement-breakpoint
ALTER TABLE mi_save_runs ADD COLUMN IF NOT EXISTS realized_lift_pct numeric(10,2);
--> statement-breakpoint
ALTER TABLE mi_save_runs ADD COLUMN IF NOT EXISTS incremental_revenue numeric(16,2);
--> statement-breakpoint
ALTER TABLE mi_save_runs ADD COLUMN IF NOT EXISTS realized_net_benefit numeric(16,2);
--> statement-breakpoint
ALTER TABLE mi_save_runs ADD COLUMN IF NOT EXISTS measured_at timestamptz;
--> statement-breakpoint
ALTER TABLE mi_save_runs ADD COLUMN IF NOT EXISTS measured_by text;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS mi_save_targets (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  run_id bigint NOT NULL REFERENCES mi_save_runs(id),
  member_id bigint NOT NULL,
  arm text NOT NULL DEFAULT 'treatment',
  offer numeric(14,2),
  expected_saved numeric(14,2),
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mi_save_targets_tenant ON mi_save_targets (tenant_id, run_id, arm);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ux_mi_save_targets_member ON mi_save_targets (tenant_id, run_id, member_id);
--> statement-breakpoint

-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form). Idempotent.
-- EXCLUDE audit_expectations: migration 0465 deliberately gives it a PERMISSIVE tenant_isolation policy
-- (USING/CHECK true) so the in-business-tx audit-expectation bump never violates RLS and aborts the tx
-- (a god acting-as a company bumps under the TARGET app.tenant_id) — re-applying the scoped 0232 body
-- here would reintroduce a 500 on god sign-off (cf. the 0218 org-clause clobber gotcha). Leave it untouched.
DO $$ DECLARE r record; BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' AND table_name <> 'audit_expectations' LOOP
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
