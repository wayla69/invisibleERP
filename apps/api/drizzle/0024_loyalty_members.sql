-- POS Tier 2 #9 — Loyalty / membership at POS (สมาชิก/แต้มที่จุดขาย).
-- End-consumer members per shop + append-only points ledger. tenant_id REQUIRED → RLS.
CREATE TABLE IF NOT EXISTS pos_members (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  member_code text NOT NULL,
  name text, phone text, card_no text, email text,
  balance numeric DEFAULT 0,
  lifetime numeric DEFAULT 0,
  tier text DEFAULT 'Standard',
  active boolean DEFAULT true,
  enrolled_at timestamptz DEFAULT now(),
  last_updated timestamptz,
  created_by text
);
CREATE UNIQUE INDEX IF NOT EXISTS pos_members_tenant_code ON pos_members (tenant_id, member_code);
CREATE UNIQUE INDEX IF NOT EXISTS pos_members_tenant_phone ON pos_members (tenant_id, phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pos_members_tenant_card ON pos_members (tenant_id, card_no) WHERE card_no IS NOT NULL;

CREATE TABLE IF NOT EXISTS pos_member_ledger (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  member_id bigint REFERENCES pos_members(id),
  txn_date timestamptz DEFAULT now(),
  txn_type text,
  points numeric,
  redeem_value numeric(14,2) DEFAULT 0,
  balance_after numeric,
  ref_doc text,
  notes text,
  created_by text
);
CREATE INDEX IF NOT EXISTS pos_member_ledger_member ON pos_member_ledger (member_id);
CREATE INDEX IF NOT EXISTS pos_member_ledger_ref ON pos_member_ledger (ref_doc);

-- Re-run the 0002 RLS loop so pos_members + pos_member_ledger (tenant_id) are isolation-scoped.
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
