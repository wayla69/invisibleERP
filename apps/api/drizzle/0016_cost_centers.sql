-- Phase 14 — Accounting Tier 3: Cost Centers / accounting dimensions.
-- Pure dimensional tag on journal_lines — NO new GL postings. Dimensional P&L / TB.
DO $$ BEGIN CREATE TYPE cost_center_type AS ENUM ('department','branch','project'); EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS cost_centers (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  type cost_center_type NOT NULL DEFAULT 'department',
  parent_code text,
  active text DEFAULT 'true',
  created_by text,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT uq_cost_center UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS idx_cc_parent ON cost_centers(parent_code);

-- Dimension tag on journal lines (nullable → backward compatible; untagged = Unassigned).
ALTER TABLE journal_lines ADD COLUMN IF NOT EXISTS cost_center_code text;
CREATE INDEX IF NOT EXISTS idx_jl_cc ON journal_lines(cost_center_code);

-- Re-run the 0002 RLS loop so cost_centers (tenant_id) is isolation-scoped.
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
