-- Adversarial-verify fix #2: promotions were GLOBAL (no tenant_id) → a promo code leaked across tenants
-- (cross-tenant lookup; one shop's traffic could exhaust another shop's code). Scope them per tenant.
-- Add tenant_id to promotions + promotion_items, then re-run the 0002 RLS loop so both are isolation-scoped
-- (PromoEngineService also filters its lookup by tenant for defense-in-depth + Admin-bypass correctness).
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS tenant_id bigint REFERENCES tenants(id);
ALTER TABLE promotion_items ADD COLUMN IF NOT EXISTS tenant_id bigint REFERENCES tenants(id);
CREATE INDEX IF NOT EXISTS idx_promotions_tenant ON promotions(tenant_id);

-- Re-run the 0002 RLS loop so promotions + promotion_items (now carrying tenant_id) are isolation-scoped.
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
