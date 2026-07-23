-- 0473_mi_save_autopilot
-- docs/61 Phase 5 — Churn-Save Autopilot (control MKT-24). Protect the base + PROVE the saved revenue.
-- The save-offer POLICY (churn threshold, min CLV to justify a save, offer rate, and a hard OFFER CAP) is
-- MAKER-CHECKER approved — a Pending policy must be approved by a DIFFERENT user before it is Active. A sweep
-- applies the Active policy to at-risk customers, computes a CAPPED win-back offer, assigns a randomised
-- HOLDOUT arm (the same deterministic hash as MKT-19), and records a retention P&L (expected saved revenue
-- vs offer cost). Consent-gated + draft-only — nothing auto-sends. Read/orchestration model — no GL posting.
--
-- Tenancy: both tables carry tenant_id → the canonical 0232-form org RLS policy (trailing DO block) +
-- a LEADING (tenant_id, …) index.

CREATE TABLE IF NOT EXISTS mi_save_policies (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  policy_no text NOT NULL,                               -- SAVEPOL-YYYYMMDD-NNN
  churn_threshold numeric(5,4) NOT NULL DEFAULT 0.5,     -- [0,1] — sweep customers at/above this churn risk
  min_clv numeric(14,2) NOT NULL DEFAULT 0,              -- only save customers whose CLV justifies it
  offer_rate numeric(6,4) NOT NULL DEFAULT 0.1,          -- offer = clv × rate, then capped
  offer_cap numeric(14,2) NOT NULL DEFAULT 500,          -- HARD per-offer cap (the control)
  status text NOT NULL DEFAULT 'Pending',                -- Pending | Active | Superseded
  note text,
  requested_by text,
  approved_by text,
  created_at timestamptz DEFAULT now(),
  approved_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mi_save_pol_tenant ON mi_save_policies (tenant_id, status, created_at DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ux_mi_save_pol_no ON mi_save_policies (tenant_id, policy_no);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS mi_save_runs (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  run_no text NOT NULL,                                  -- SAVE-YYYYMMDD-NNN
  policy_no text,                                        -- the Active policy applied
  segment text,
  treatment_count integer NOT NULL DEFAULT 0,
  control_count integer NOT NULL DEFAULT 0,
  offer_cost numeric(16,2),                              -- Σ capped offers (treatment)
  expected_saved_revenue numeric(16,2),
  net_benefit numeric(16,2),                             -- saved − cost
  campaign_id bigint,
  requested_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mi_save_run_tenant ON mi_save_runs (tenant_id, created_at DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ux_mi_save_run_no ON mi_save_runs (tenant_id, run_no);
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
