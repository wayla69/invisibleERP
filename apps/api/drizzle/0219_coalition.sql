-- 0219_coalition — docs/27 Phase W2: coalition network (earn anywhere, burn anywhere, settle in the GL).
-- `coalitions` is HQ-owned master data (no tenant_id — like tenants itself); `coalition_members` maps
-- shops into a coalition (tenant_id → RLS; cross-shop reads run through the service's validated
-- bypass context, control LYL-19). Earn/burn stays on the member's HOME ledger via earnInTx/redeemInTx;
-- every cross-shop movement posts an intercompany clearing entry (category 'loyalty-clearing', 5700↔1150/2150).
-- New IC category for coalition point-movement clearing entries (not exposed on the manual IC endpoint).
ALTER TYPE ic_category ADD VALUE IF NOT EXISTS 'loyalty-clearing';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS coalitions (
  id bigserial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS coalition_members (
  id bigserial PRIMARY KEY,
  coalition_id bigint NOT NULL REFERENCES coalitions(id),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  active boolean NOT NULL DEFAULT true,
  joined_at timestamptz DEFAULT now(),
  created_by text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS coalition_members_coalition_tenant ON coalition_members (coalition_id, tenant_id);
--> statement-breakpoint
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
