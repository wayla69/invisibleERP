-- 0345_landed_cost — INV-1: Landed-cost allocation (COST-01). A landed-cost voucher attaches freight / duty /
-- insurance / broker charges to one or more posted goods receipts and apportions them into inventory unit
-- cost (allocation basis: value / qty / weight). Posting capitalises the still-on-hand share into the
-- perpetual inventory sub-ledger (Dr 1200 / raises moving-avg + open cost layers) and expenses the
-- already-issued residual to the costing variance account (Dr 5500 — mirroring STD-costing PPV), crediting
-- the landed-cost accrual liability (2010). Maker-checker: the poster must differ from the preparer
-- (403 SOD_SELF_APPROVAL) — no new permission/SoD rule (reuses the write-off maker-checker pattern).
--
-- Two tenant-scoped tables: a leading (tenant_id, …) index on each + the CANONICAL 0232-form
-- tenant_isolation RLS policy (re-applied via the generic DO-loop below) + app_user grants. Also registers
-- the LANDEDCOST.CAPITALIZE posting-event type for /setup/posting-rules. Idempotent; PGlite + Postgres alike.
CREATE TABLE IF NOT EXISTS landed_cost_vouchers (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  voucher_no text NOT NULL,
  voucher_date date NOT NULL,
  basis text NOT NULL DEFAULT 'value',
  currency text NOT NULL DEFAULT 'THB',
  freight numeric(18,2) NOT NULL DEFAULT 0,
  duty numeric(18,2) NOT NULL DEFAULT 0,
  insurance numeric(18,2) NOT NULL DEFAULT 0,
  broker numeric(18,2) NOT NULL DEFAULT 0,
  total_charges numeric(18,2) NOT NULL DEFAULT 0,
  accrual_account text NOT NULL DEFAULT '2010',
  status text NOT NULL DEFAULT 'Draft',
  memo text,
  capitalized_total numeric(18,2) NOT NULL DEFAULT 0,
  variance_total numeric(18,2) NOT NULL DEFAULT 0,
  prepared_by text,
  prepared_at timestamptz DEFAULT now(),
  posted_by text,
  posted_at timestamptz,
  gl_entry_no text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS landed_cost_allocations (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  voucher_no text NOT NULL,
  gr_no text,
  item_id text NOT NULL,
  location_id text NOT NULL DEFAULT 'WH-MAIN',
  qty numeric(18,4) NOT NULL DEFAULT 0,
  weight numeric(18,4) NOT NULL DEFAULT 0,
  base_value numeric(18,2) NOT NULL DEFAULT 0,
  alloc_amount numeric(18,2) NOT NULL DEFAULT 0,
  capitalized_amount numeric(18,2) NOT NULL DEFAULT 0,
  variance_amount numeric(18,2) NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_lcv_no ON landed_cost_vouchers (tenant_id, voucher_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lcv_tenant ON landed_cost_vouchers (tenant_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lca_tenant ON landed_cost_allocations (tenant_id, voucher_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lca_item ON landed_cost_allocations (tenant_id, item_id);
--> statement-breakpoint
-- Register the posting-event type (governed on /setup/posting-rules; the registry in posting-events.ts is
-- the code-side source of truth). Idempotent.
INSERT INTO posting_event_types (key, name, description) VALUES
  ('LANDEDCOST.CAPITALIZE', 'Landed-cost capitalisation', 'Freight/duty/insurance/broker apportioned into inventory unit cost (COST-01)')
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
