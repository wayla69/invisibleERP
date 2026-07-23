-- 0471_mi_nba_journeys
-- docs/61 Phase 3 — Next-Best-Action Orchestrator (control MKT-22). Turns the advisory mi_nba into
-- SEQUENCED, PRIORITISED action per customer. A journey is STAGED (Pending) with its per-customer targets —
-- each carrying the chosen action, its expected value (CLV × action uplift), and a FIXED holdout arm
-- (treatment/control, the same deterministic hash as MKT-19) — and requires MAKER-CHECKER activation by a
-- DIFFERENT user before any consent-gated draft is created. Suppression (consent off / recent purchase /
-- no action) is enforced at STAGE time and RECORDED on each target, so the control is auditable and nothing
-- auto-sends. Read/orchestration model — no GL posting.
--
-- Tenancy: both tables carry tenant_id → the canonical 0232-form org RLS policy (trailing DO block) +
-- a LEADING (tenant_id, …) index.

-- Journey header: one per staged plan.
CREATE TABLE IF NOT EXISTS mi_journeys (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  journey_no text NOT NULL,                              -- NBA-YYYYMMDD-NNN
  segment text,                                          -- the mi_segment scoped (null = all scored members)
  channel text NOT NULL DEFAULT 'sms',
  status text NOT NULL DEFAULT 'Pending',                -- Pending | Active | Cancelled
  control_pct numeric(5,4) NOT NULL DEFAULT 0.2,         -- holdout fraction [0,1)
  target_count integer NOT NULL DEFAULT 0,               -- treatment targets (contactable)
  control_count integer NOT NULL DEFAULT 0,              -- holdout (never contacted)
  suppressed_count integer NOT NULL DEFAULT 0,
  campaign_id bigint,                                    -- the consent-gated draft created at activation
  note text,
  requested_by text,
  approved_by text,
  created_at timestamptz DEFAULT now(),
  activated_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mi_journeys_tenant ON mi_journeys (tenant_id, status, created_at DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ux_mi_journeys_no ON mi_journeys (tenant_id, journey_no);
--> statement-breakpoint

-- Target membership — one row per (journey, member), FIXED at stage, never re-randomised.
CREATE TABLE IF NOT EXISTS mi_journey_targets (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  journey_id bigint NOT NULL REFERENCES mi_journeys(id),
  member_id bigint NOT NULL,
  action text,                                           -- the mi_nba chosen (null when suppressed with no action)
  expected_value numeric(14,2),
  arm text NOT NULL DEFAULT 'treatment',                 -- treatment | control
  suppressed boolean NOT NULL DEFAULT false,
  suppress_reason text,                                  -- CONSENT | RECENT_PURCHASE | NO_ACTION
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ux_mi_journey_targets_member ON mi_journey_targets (tenant_id, journey_id, member_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mi_journey_targets_tenant ON mi_journey_targets (tenant_id, journey_id, arm);
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
