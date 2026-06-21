-- Phase 15 — Accounting Tier 3 batch 2: Intercompany (ระหว่างกิจการ).
-- Mirrored due-from/due-to across two tenants; reconcilable + eliminable on consolidation. GL-backed.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ic_category') THEN CREATE TYPE ic_category AS ENUM ('shared-cost','transfer','loan'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ic_status') THEN CREATE TYPE ic_status AS ENUM ('Open','Partial','Settled'); END IF;
END $$;

CREATE TABLE IF NOT EXISTS ic_transactions (
  id bigserial PRIMARY KEY,
  ic_no text NOT NULL UNIQUE,
  tenant_id bigint REFERENCES tenants(id),
  from_tenant_id bigint NOT NULL REFERENCES tenants(id),
  to_tenant_id bigint NOT NULL REFERENCES tenants(id),
  txn_date date NOT NULL,
  amount numeric(18,4) NOT NULL,
  settled_amount numeric(18,4) NOT NULL DEFAULT 0,
  currency text DEFAULT 'THB',
  category ic_category NOT NULL DEFAULT 'shared-cost',
  description text,
  status ic_status NOT NULL DEFAULT 'Open',
  from_journal_no text,
  to_journal_no text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ic_from ON ic_transactions(from_tenant_id);
CREATE INDEX IF NOT EXISTS idx_ic_to ON ic_transactions(to_tenant_id);
CREATE INDEX IF NOT EXISTS idx_ic_status ON ic_transactions(status);

CREATE TABLE IF NOT EXISTS ic_settlements (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  ic_no text NOT NULL REFERENCES ic_transactions(ic_no),
  settle_date date NOT NULL,
  amount numeric(18,4) NOT NULL,
  from_journal_no text,
  to_journal_no text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ic_settle_ic ON ic_settlements(ic_no);

-- Re-run the 0002 RLS loop so ic_transactions + ic_settlements (tenant_id) are isolation-scoped.
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
