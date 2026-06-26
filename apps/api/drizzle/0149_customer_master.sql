-- 0149 — Unified customer master / customer-of-record (REV-15). The business had two disjoint customer
-- silos: B2C loyalty members (pos_members) and B2B accounts (a customer is a tenant with AR). This adds a
-- single registry that LINKS both — member_id → pos_members (loyalty) and account_code → the B2B customer
-- tenant (orders + AR) — so a 360° view and revenue-by-customer have one customer-of-record. Additive: the
-- existing silos are untouched; the master references them.
CREATE TABLE IF NOT EXISTS customer_master (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),          -- owning (seller) tenant
  customer_no text NOT NULL,                          -- CUS-YYYYMMDD-NNN
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'person',               -- person | company
  email text,
  phone text,
  tax_id text,
  member_id bigint,                                   -- → pos_members.id (B2C loyalty link)
  account_code text,                                  -- the B2B customer tenant code (orders + AR)
  status text NOT NULL DEFAULT 'active',             -- active | inactive
  notes text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_master_no ON customer_master (tenant_id, customer_no);
CREATE INDEX IF NOT EXISTS idx_customer_master_name ON customer_master (tenant_id, name);
CREATE INDEX IF NOT EXISTS idx_customer_master_member ON customer_master (member_id);

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
