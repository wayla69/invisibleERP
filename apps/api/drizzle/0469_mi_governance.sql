-- 0469_mi_governance
-- docs/60 Phase 4 — Model Governance (SOX / ICFR-fit). Because the pushed analytics now DRIVE spend and
-- customer contact, put ITGC-grade governance around them: a pushed snapshot that will inform a budget
-- decision or a campaign must be APPROVED by a second person before activate/budget-plan can consume it;
-- each run carries a model card (version / training window / metrics / features); drift vs the prior
-- approved run is flagged and can block consumption.
--
-- Back-compat: status DEFAULTS to 'Approved', so a tenant that has NOT enabled governance is unchanged
-- (every snapshot is consumable). Enabling mi_governance_settings.require_approval makes new pushes land
-- 'Pending' and consumers require 'Approved'.

ALTER TABLE mi_analytics_snapshots ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'Approved'; -- Pending | Approved | Rejected
ALTER TABLE mi_analytics_snapshots ADD COLUMN IF NOT EXISTS approved_by text;
ALTER TABLE mi_analytics_snapshots ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE mi_analytics_snapshots ADD COLUMN IF NOT EXISTS model_card jsonb;   -- { model_version, training_window, features, metrics, … }
ALTER TABLE mi_analytics_snapshots ADD COLUMN IF NOT EXISTS quality jsonb;       -- { r2, prev_r2, r2_drop, drift, blocked, … } computed at push
--> statement-breakpoint
-- Approval-queue lookups: pending runs per tenant.
CREATE INDEX IF NOT EXISTS idx_mi_snapshots_status ON mi_analytics_snapshots (tenant_id, status, pushed_at DESC);
--> statement-breakpoint

-- Per-tenant governance toggle (one row per tenant; absent ⇒ governance OFF, back-compat).
CREATE TABLE IF NOT EXISTS mi_governance_settings (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  require_approval boolean NOT NULL DEFAULT false,   -- gate activate/budget-plan on an approved run
  drift_r2_drop numeric(5,4) NOT NULL DEFAULT 0.15,  -- an R² drop beyond this flags + blocks the run
  updated_by text,
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ux_mi_governance_tenant ON mi_governance_settings (tenant_id);
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
