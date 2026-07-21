-- 0460_marketing_intel_snapshots
-- Marketing Intelligence push-back store (docs/48 phase 3). The standalone Python Marketing
-- Intelligence Platform computes advanced MMM / Sentiment-Weighted RFM / TOWS in its OWN data
-- warehouse and PUSHES the results back into the ERP over the public API (scope analytics:write),
-- so the ERP owns the data it displays at /marketing-intel and never joins across databases
-- (DB-isolation rule). One row per (tenant, kind); the writer upserts the LATEST snapshot per kind.
--
-- Tenancy: tenant-scoped — carries tenant_id and gets the CANONICAL 0232-form org-scoped
-- tenant_isolation policy from the trailing DO block, plus a LEADING (tenant_id, …) index (the
-- cutover:tenant-idx gate requires one). Read model only — no GL posting.

CREATE TABLE IF NOT EXISTS mi_analytics_snapshots (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  kind text NOT NULL,                                  -- mmm | rfm | tows
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,          -- the computed result set (channels / segments / quadrants)
  model_run_ref text,                                  -- the platform-side run id / run_no (audit / repro)
  source text NOT NULL DEFAULT 'mi-platform',
  pushed_by text,                                      -- the API-key principal that pushed it
  pushed_at timestamptz DEFAULT now()
);
--> statement-breakpoint
-- Idempotent push: the latest snapshot per (tenant, kind) wins (writer does ON CONFLICT DO UPDATE).
CREATE UNIQUE INDEX IF NOT EXISTS uq_mi_snapshot_kind ON mi_analytics_snapshots (tenant_id, kind);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mi_snapshots_tenant ON mi_analytics_snapshots (tenant_id, kind);
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
