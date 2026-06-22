-- Phase 18: Projects / PPM — projects + logged cost entries. Tenant-scoped (RLS).
-- NOTE: numbered 0051 in this worktree (main journal ends at 0050); reconcile idx vs the parallel
-- 0051_pos_p0 batch at merge (distinct table names → no SQL conflict).
CREATE TABLE IF NOT EXISTS projects (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT REFERENCES tenants(id),
  project_code    TEXT NOT NULL,
  name            TEXT NOT NULL,
  customer_name   TEXT,
  billing_type    TEXT NOT NULL DEFAULT 'TM',
  budget_amount   NUMERIC(16,2) DEFAULT 0,
  contract_amount NUMERIC(16,2) DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'Open',
  cost_to_date    NUMERIC(16,2) DEFAULT 0,
  recognized_cost NUMERIC(16,2) DEFAULT 0,
  billed_to_date  NUMERIC(16,2) DEFAULT 0,
  start_date      DATE,
  end_date        DATE,
  created_by      TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_tenant ON projects(tenant_id);

CREATE TABLE IF NOT EXISTS project_entries (
  id              BIGSERIAL PRIMARY KEY,
  project_id      BIGINT NOT NULL REFERENCES projects(id),
  tenant_id       BIGINT REFERENCES tenants(id),
  entry_type      TEXT NOT NULL DEFAULT 'time',
  description     TEXT,
  qty             NUMERIC(14,2) DEFAULT 0,
  rate            NUMERIC(14,2) DEFAULT 0,
  amount          NUMERIC(16,2) NOT NULL DEFAULT 0,
  billable        BOOLEAN DEFAULT true,
  entry_date      DATE,
  entry_no        TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pe_project ON project_entries(project_id);

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT unnest(ARRAY['projects','project_entries']) AS table_name LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I'
      || ' USING (coalesce(current_setting(''app.bypass_rls'', true), '''') = ''on'''
      || '        OR tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint)'
      || ' WITH CHECK (coalesce(current_setting(''app.bypass_rls'', true), '''') = ''on'''
      || '        OR tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint)',
      r.table_name);
  END LOOP;
END $$;
