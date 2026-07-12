-- 0355_treasury_hedge_register — Track C Wave 3: Hedge accounting register (control TRE-04; IFRS 9 / TFRS 9 ·
-- ASC 815). A hedge RELATIONSHIP is DESIGNATED under maker-checker (create → PendingApproval carrying the hedged
-- item, the hedging instrument, the hedge TYPE (CASH_FLOW | FAIR_VALUE), the hedge ratio and the formal
-- documentation; a DIFFERENT user approves → Approved; self-approve → SOD_SELF_APPROVAL). THE CONTROL: no
-- hedge/OCI accounting until the relationship is Approved AND its LATEST effectiveness test is effective=true.
--   • CASH_FLOW — the EFFECTIVE portion of the derivative fair-value change defers in the Cash-Flow Hedge Reserve
--     3550 (OCI equity, mirroring the Wave-2 FVOCI reserve 3500); the INEFFECTIVE portion → P&L 5450. When the
--     relationship is not Approved+effective the OCI path is refused (HEDGE_NOT_EFFECTIVE) and the whole change is
--     routed to P&L. Reclassification recycles 3550 → the hedged-item revenue line when the cash flow occurs.
--   • FAIR_VALUE — the derivative change → P&L 5450 and the hedged item is BASIS-ADJUSTED (its carrying account)
--     with an offsetting P&L leg.
-- The derivative fair-value change posts Dr 1380 Derivative Asset (gain) / Cr 2460 Derivative Liability (loss).
--
-- Four tenant-scoped tables — each with a leading (tenant_id, …) index + the CANONICAL 0232-form
-- tenant_isolation RLS policy (re-applied via the generic DO-loop below) + app_user grants. Also registers the
-- HEDGE.* posting-event types for /setup/posting-rules. Idempotent; PGlite + Postgres alike. (No new role_enum
-- values — the Wave-1 treasury/treasury_approve duties + TreasuryAnalyst/TreasuryManager roles are reused.)

CREATE TABLE IF NOT EXISTS hedge_relationships (
  id bigserial PRIMARY KEY,
  hedge_no text NOT NULL UNIQUE,
  tenant_id bigint REFERENCES tenants(id),
  hedged_item text NOT NULL,
  hedging_instrument text NOT NULL,
  hedge_type text NOT NULL DEFAULT 'CASH_FLOW',
  hedge_ratio numeric(9,4) NOT NULL DEFAULT 1,
  notional numeric(18,2) NOT NULL DEFAULT 0,
  documentation text NOT NULL,
  hedged_item_account text,
  reclass_account text,
  currency text NOT NULL DEFAULT 'THB',
  derivative_fv numeric(18,2) NOT NULL DEFAULT 0,
  oci_reserve numeric(18,2) NOT NULL DEFAULT 0,
  basis_adjustment numeric(18,2) NOT NULL DEFAULT 0,
  rebalances integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'PendingApproval',
  requested_by text,
  approved_by text,
  approved_at timestamptz,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hedge_relationships_tenant ON hedge_relationships (tenant_id, hedge_type, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS hedge_derivatives (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  relationship_id bigint REFERENCES hedge_relationships(id),
  instrument text,
  notional numeric(18,2) NOT NULL DEFAULT 0,
  fair_value numeric(18,2) NOT NULL DEFAULT 0,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hedge_derivatives_tenant ON hedge_derivatives (tenant_id, relationship_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS hedge_effectiveness_tests (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  relationship_id bigint REFERENCES hedge_relationships(id),
  test_type text NOT NULL DEFAULT 'prospective',
  method text NOT NULL DEFAULT 'dollar_offset',
  ratio_pct numeric(9,4) NOT NULL DEFAULT 0,
  effective boolean NOT NULL DEFAULT false,
  as_of date,
  notes text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hedge_effectiveness_tests_tenant ON hedge_effectiveness_tests (tenant_id, relationship_id, as_of);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS hedge_oci_movements (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  relationship_id bigint REFERENCES hedge_relationships(id),
  as_of date,
  amount numeric(18,2) NOT NULL DEFAULT 0,
  pl_amount numeric(18,2) NOT NULL DEFAULT 0,
  reclassified boolean NOT NULL DEFAULT false,
  entry_no text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hedge_oci_movements_tenant ON hedge_oci_movements (tenant_id, relationship_id, as_of);
--> statement-breakpoint
-- Register the posting-event types (governed on /setup/posting-rules; the registry in posting-events.ts is the
-- code-side source of truth). Idempotent.
INSERT INTO posting_event_types (key, name, description) VALUES
  ('HEDGE.DERIVATIVE.MTM', 'Hedging derivative remeasurement', 'Derivative fair-value change — Dr 1380 Derivative Asset (gain) / Cr 2460 Derivative Liability (loss); offset to OCI 3550 or P&L 5450 (TRE-04)'),
  ('HEDGE.CF.OCI', 'Cash-flow hedge — effective portion to OCI', 'Effective portion of a CASH_FLOW hedge deferred in the Cash-Flow Hedge Reserve 3550 (OCI equity), only when Approved + effective (TRE-04)'),
  ('HEDGE.RECLASSIFY', 'Cash-flow hedge — OCI reclassification', 'Deferred OCI recycled to earnings — Dr 3550 / Cr the hedged-item revenue/P&L line when the hedged cash flow occurs (TRE-04)'),
  ('HEDGE.FV.BASIS', 'Fair-value hedge — hedged-item basis adjustment', 'FAIR_VALUE hedge — the hedged risk fair-value change adjusts the hedged item carrying account with an offsetting P&L leg 5450 (TRE-04)')
ON CONFLICT (key) DO NOTHING;
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
