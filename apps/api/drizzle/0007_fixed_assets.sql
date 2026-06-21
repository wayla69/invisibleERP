-- Phase 13 — Accounting Tier 2: Fixed Assets + Depreciation (FI-AA).
-- Straight-line monthly depreciation, consolidated GL posting per period, disposal gain/loss.
DO $$ BEGIN CREATE TYPE dep_method AS ENUM ('straight_line'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE asset_status AS ENUM ('active','disposed','fully_depreciated'); EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS asset_categories (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  code text NOT NULL, name text NOT NULL,
  default_useful_life_years integer NOT NULL DEFAULT 5,
  asset_account text NOT NULL DEFAULT '1500',
  accum_dep_account text NOT NULL DEFAULT '1590',
  dep_expense_account text NOT NULL DEFAULT '5200',
  active text DEFAULT 'true',
  created_at timestamptz DEFAULT now(),
  CONSTRAINT uq_asset_cat UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS fixed_assets (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  asset_no text NOT NULL,
  category_id bigint REFERENCES asset_categories(id),
  name text NOT NULL,
  acquire_date date NOT NULL,
  acquire_cost numeric(18,4) NOT NULL,
  salvage_value numeric(18,4) NOT NULL DEFAULT 0,
  useful_life_months integer NOT NULL,
  depreciation_method dep_method NOT NULL DEFAULT 'straight_line',
  status asset_status NOT NULL DEFAULT 'active',
  accumulated_depreciation numeric(18,4) NOT NULL DEFAULT 0,
  net_book_value numeric(18,4) NOT NULL,
  last_depreciated_period text,
  disposed_date date,
  disposal_proceeds numeric(18,4),
  disposal_gain_loss numeric(18,4),
  acquire_source text NOT NULL DEFAULT 'cash',
  notes text, created_by text,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT uq_fixed_asset_no UNIQUE (tenant_id, asset_no)
);
CREATE INDEX IF NOT EXISTS idx_fa_status ON fixed_assets(status);

CREATE TABLE IF NOT EXISTS depreciation_runs (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  run_no text NOT NULL, period text NOT NULL,
  posted_at timestamptz DEFAULT now(),
  total_depreciation numeric(18,4) NOT NULL,
  asset_count integer NOT NULL DEFAULT 0,
  journal_no text, created_by text,
  CONSTRAINT uq_dep_run_period UNIQUE (tenant_id, period)
);

CREATE TABLE IF NOT EXISTS depreciation_lines (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  run_id bigint NOT NULL REFERENCES depreciation_runs(id),
  asset_id bigint NOT NULL REFERENCES fixed_assets(id),
  amount numeric(18,4) NOT NULL,
  accumulated_after numeric(18,4) NOT NULL,
  nbv_after numeric(18,4) NOT NULL
);

-- Re-run the 0002 RLS loop so the new tenant_id tables are isolation-scoped.
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
