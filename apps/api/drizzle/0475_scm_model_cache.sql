-- docs/59 Track D (D2) — warm-start / model registry.
--
-- One serialized Prophet fit per (tenant, branch, item). The API extracts it under RLS and ships it in
-- the /v1/forecast payload as `warm_start`; the engine SKIPS the cmdstan refit when `fit_hash` still
-- matches the current training window (the compute win), else it refits and returns fresh state the API
-- upserts back here. Determinism is preserved: the fit is MAP/L-BFGS (no RNG) and sampling is reseeded,
-- so a reuse reproduces the cold fit byte-for-byte. A stale fit is caught two ways — fit_hash mismatch
-- (window changed) and refit_cadence_days (age), both fail-safe toward refitting.
--
-- Tenancy: carries tenant_id, so the trailing DO block's CANONICAL 0232-form org loop enables
-- tenant_isolation; the leading (tenant_id, branch_id, item_id) index satisfies the cutover:tenant-idx
-- gate. Only the scm-planning run writes it (no cross-writer NULL-tenant fan-out to sweep). The UNIQUE on
-- coalesce(branch_id, 0) makes the NULL-branch (tenant-wide) row unique per (tenant, item, model) —
-- written here because drizzle-kit cannot express an expression index.
CREATE TABLE IF NOT EXISTS scm_model_cache (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  branch_id bigint,
  item_id text NOT NULL,
  model text NOT NULL,
  fit_params jsonb NOT NULL,
  fit_hash text NOT NULL,
  fit_wape numeric(10,4),
  training_from date,
  training_to date,
  fitted_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_scm_model_cache_series ON scm_model_cache (tenant_id, coalesce(branch_id, 0), item_id, model);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_scm_model_cache_tenant ON scm_model_cache (tenant_id, branch_id, item_id);
--> statement-breakpoint

-- docs/59 D2 — warm-start refit cadence (additive; default preserves prior behaviour).
ALTER TABLE scm_settings ADD COLUMN IF NOT EXISTS refit_cadence_days integer NOT NULL DEFAULT 14;
--> statement-breakpoint

-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form). Idempotent.
--
-- EXCLUDES `audit_expectations` (migration 0465). That table carries a tenant_id column, so this generic
-- loop would sweep it in — but its tenant_isolation policy is DELIBERATELY permissive (USING/ WITH CHECK
-- true), and re-scoping it here is a real bug, not bureaucracy: the completeness counter is bumped INSIDE
-- the business transaction and is keyed on the AUDIT ROW's tenant (the operator's own), while a god
-- acting-as another company runs with app.tenant_id pinned to the TARGET and bypass OFF. A scoped WITH
-- CHECK therefore REJECTS that bump, and a statement that fails inside the business tx ABORTS it (25P02) —
-- taking every god act-as POST/PATCH/DELETE down with it (bit cutover:sme's god sign-off). 0465 chose a
-- permissive policy over a savepoint on purpose (see its header); this loop must not silently undo that.
-- Any future migration copying this loop MUST keep this exclusion.
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
