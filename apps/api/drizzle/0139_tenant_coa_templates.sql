-- 0139 — Industry Chart-of-Accounts templates (per-tenant CoA overlay).
-- The canonical `accounts` table stays the GLOBAL, immutable posting universe (the engine hard-references
-- its codes). This adds:
--   tenants.industry   the CoA template a company picked at signup ('restaurant'|'retail'|'distribution'
--                      |'services'|'general'); nullable for legacy tenants (treated as 'general').
--   tenant_accounts    per-tenant overlay curating which canonical accounts are active and how they are
--                      named/grouped on that tenant's chart. Never gates postings; materialised from an
--                      industry template at signup (LedgerService.provisionTenantCoA), idempotent.
-- Control GL-10 (provisioning narrative). tenant_accounts carries tenant_id → re-run the 0002 RLS loop.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS industry text;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS tenant_accounts (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  account_code text NOT NULL,                    -- FK-ish to accounts.code (canonical universe)
  display_name text,                             -- industry display name (EN); null = use canonical name
  display_name_th text,
  group_label text,                              -- section heading (defaults to account type)
  active boolean DEFAULT true,
  sort_order bigint DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT uq_tenant_accounts_tenant_code UNIQUE (tenant_id, account_code)
);
--> statement-breakpoint

-- Re-run the 0002 RLS loop so the new tenant_id table is isolation-scoped.
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
