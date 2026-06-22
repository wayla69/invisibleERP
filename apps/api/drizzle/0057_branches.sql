-- 0054_branches: Multi-branch POS — physical outlets within a tenant that sell independently
-- (offline-first) and roll their sales up to the tenant's HQ for consolidation.
CREATE TABLE IF NOT EXISTS branches (
  id          bigserial PRIMARY KEY,
  tenant_id   bigint REFERENCES tenants(id),
  code        text NOT NULL,
  name        text NOT NULL,
  is_hq       boolean DEFAULT false,
  address     text,
  phone       text,
  active      boolean DEFAULT true,
  created_by  text,
  created_at  timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS branches_tenant_code_uq ON branches(tenant_id, code);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_branches_tenant ON branches(tenant_id);
--> statement-breakpoint

-- Branch tag on the transactional tables (NULL = untagged/HQ, backward-compatible with existing rows).
ALTER TABLE cust_pos_sales   ADD COLUMN IF NOT EXISTS branch_id bigint;
--> statement-breakpoint
ALTER TABLE cust_stock_log   ADD COLUMN IF NOT EXISTS branch_id bigint;
--> statement-breakpoint
ALTER TABLE pos_offline_sync ADD COLUMN IF NOT EXISTS branch_id bigint;
--> statement-breakpoint

-- Re-run the dynamic RLS loop so the new tenant_id table (branches) is isolated like every other.
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
