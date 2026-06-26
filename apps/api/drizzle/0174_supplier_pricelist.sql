-- 0174: Supplier price-list versioning (T2-D)
-- Versioned purchase price list per vendor+item+uom. Each upsert supersedes the prior active row
-- (status 'active' → 'superseded'). Feeds price_var_pct in supplier_scorecards at scorecard
-- recompute time (recomputeScorecard compares GR unit_cost vs active list price for the vendor+item).

CREATE TABLE IF NOT EXISTS supplier_price_lists (
  id             bigserial PRIMARY KEY,
  tenant_id      bigint REFERENCES tenants(id),
  vendor_id      bigint NOT NULL REFERENCES vendors(id),
  item_id        text NOT NULL,
  item_description text,
  uom            text NOT NULL DEFAULT 'EA',
  currency       text NOT NULL DEFAULT 'THB',
  unit_price     numeric(18, 4) NOT NULL,
  min_qty        numeric(14, 4) NOT NULL DEFAULT 1,
  effective_from date NOT NULL,
  effective_to   date,
  status         text NOT NULL DEFAULT 'active',  -- 'active' | 'superseded'
  notes          text,
  created_by     text,
  created_at     timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_spl_vendor_item ON supplier_price_lists (tenant_id, vendor_id, item_id);
--> statement-breakpoint
-- Re-run the RLS loop so the new tenant_id table is isolation-scoped (idempotent — DROP POLICY IF EXISTS).
DO $$ DECLARE r record; BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON public.%I'
      || ' USING (coalesce(current_setting(''app.bypass_rls'',true),'''')=''on'''
      || '   OR tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::bigint)'
      || ' WITH CHECK (coalesce(current_setting(''app.bypass_rls'',true),'''')=''on'''
      || '   OR tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::bigint)', r.table_name);
  END LOOP;
END $$;
