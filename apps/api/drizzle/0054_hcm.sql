-- Phase 19: HCM depth — employee PF/hourly + attendance + leave. Tenant-scoped (RLS).
ALTER TABLE employees ADD COLUMN IF NOT EXISTS department TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(12,2) DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS pf_rate NUMERIC(6,4) DEFAULT 0;
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS ot_pay NUMERIC(14,2) DEFAULT 0;
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS unpaid NUMERIC(14,2) DEFAULT 0;
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS pf_employee NUMERIC(14,2) DEFAULT 0;
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS pf_employer NUMERIC(14,2) DEFAULT 0;

CREATE TABLE IF NOT EXISTS timesheets (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT REFERENCES tenants(id),
  employee_id   BIGINT NOT NULL REFERENCES employees(id),
  work_date     DATE NOT NULL,
  regular_hours NUMERIC(6,2) DEFAULT 0,
  ot_hours      NUMERIC(6,2) DEFAULT 0,
  note          TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ts_emp ON timesheets(employee_id);
CREATE INDEX IF NOT EXISTS idx_ts_tenant ON timesheets(tenant_id);

CREATE TABLE IF NOT EXISTS leave_requests (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    BIGINT REFERENCES tenants(id),
  employee_id  BIGINT NOT NULL REFERENCES employees(id),
  leave_type   TEXT NOT NULL DEFAULT 'annual',
  from_date    DATE NOT NULL,
  to_date      DATE NOT NULL,
  days         NUMERIC(6,2) NOT NULL DEFAULT 0,
  paid         BOOLEAN DEFAULT true,
  status       TEXT NOT NULL DEFAULT 'Pending',
  reason       TEXT,
  created_by   TEXT,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lr_emp ON leave_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_lr_tenant ON leave_requests(tenant_id);

CREATE TABLE IF NOT EXISTS leave_balances (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    BIGINT REFERENCES tenants(id),
  employee_id  BIGINT NOT NULL REFERENCES employees(id),
  leave_type   TEXT NOT NULL,
  year         NUMERIC NOT NULL,
  entitled     NUMERIC(6,2) DEFAULT 0,
  used         NUMERIC(6,2) DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_lb_emp ON leave_balances(employee_id);

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT unnest(ARRAY['timesheets','leave_requests','leave_balances']) AS table_name LOOP
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
