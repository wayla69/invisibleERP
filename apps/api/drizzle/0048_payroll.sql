-- C2b: Payroll (เงินเดือน) — employees, monthly runs, payslips. Tenant-scoped (RLS).
-- NOTE: numbered 0048 to avoid colliding with 0047_gaps developed in parallel; reconcile the journal idx at merge.

CREATE TABLE IF NOT EXISTS employees (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT REFERENCES tenants(id),
  emp_code        TEXT NOT NULL,
  name            TEXT NOT NULL,
  national_id     TEXT,
  sso_no          TEXT,
  position        TEXT,
  monthly_salary  NUMERIC(14,2) NOT NULL DEFAULT 0,
  allowances      NUMERIC(14,2) DEFAULT 0,
  sso_eligible    BOOLEAN DEFAULT true,
  bank_account    TEXT,
  start_date      DATE,
  active          BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_emp_tenant ON employees(tenant_id);

CREATE TABLE IF NOT EXISTS payruns (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT REFERENCES tenants(id),
  period        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'Posted',
  headcount     BIGINT DEFAULT 0,
  gross_total   NUMERIC(16,2) DEFAULT 0,
  sso_ee_total  NUMERIC(16,2) DEFAULT 0,
  sso_er_total  NUMERIC(16,2) DEFAULT 0,
  wht_total     NUMERIC(16,2) DEFAULT 0,
  net_total     NUMERIC(16,2) DEFAULT 0,
  entry_no      TEXT,
  run_by        TEXT,
  run_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payrun_tenant_period ON payruns(tenant_id, period);

CREATE TABLE IF NOT EXISTS payslips (
  id            BIGSERIAL PRIMARY KEY,
  payrun_id     BIGINT NOT NULL REFERENCES payruns(id),
  tenant_id     BIGINT REFERENCES tenants(id),
  employee_id   BIGINT REFERENCES employees(id),
  emp_code      TEXT,
  emp_name      TEXT,
  national_id   TEXT,
  gross         NUMERIC(14,2) DEFAULT 0,
  sso_employee  NUMERIC(14,2) DEFAULT 0,
  sso_employer  NUMERIC(14,2) DEFAULT 0,
  wht           NUMERIC(14,2) DEFAULT 0,
  net           NUMERIC(14,2) DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payslip_run ON payslips(payrun_id);

-- Apply the dynamic tenant_isolation RLS to the new tenant-scoped tables (mirror drizzle/0002_rls.sql).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT unnest(ARRAY['employees','payruns','payslips']) AS table_name LOOP
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
