-- 0054 — Phase 18: Project Accounting / PSA. Projects, tasks, timesheets, expenses, milestones,
-- T&M + milestone billing → AR, project P&L. All tenant-scoped → RLS loop.

CREATE TABLE IF NOT EXISTS projects (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  customer_name text,
  status text DEFAULT 'Planning',        -- Planning | Active | OnHold | Closed
  billing_type text DEFAULT 'TM',        -- TM | Fixed | Milestone
  start_date date,
  end_date date,
  cost_budget numeric(16,2) DEFAULT '0',
  revenue_budget numeric(16,2) DEFAULT '0',
  default_bill_rate numeric(14,2) DEFAULT '0',
  manager text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_code ON projects (tenant_id, code);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS project_tasks (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  project_id bigint REFERENCES projects(id),
  code text,
  name text NOT NULL,
  planned_hours numeric(12,2) DEFAULT '0',
  status text DEFAULT 'Open',            -- Open | Done
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS project_timesheets (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  project_id bigint REFERENCES projects(id),
  task_id bigint REFERENCES project_tasks(id),
  employee_id bigint REFERENCES employees(id),
  emp_code text,
  work_date date,
  hours numeric(10,2) NOT NULL,
  billable boolean DEFAULT true,
  bill_rate numeric(14,2) DEFAULT '0',
  cost_rate numeric(14,2) DEFAULT '0',
  amount numeric(16,2) DEFAULT '0',      -- billable value = hours * bill_rate
  cost numeric(16,2) DEFAULT '0',        -- internal cost = hours * cost_rate
  status text DEFAULT 'Open',            -- Open | Billed
  invoice_no text,
  notes text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS project_expenses (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  project_id bigint REFERENCES projects(id),
  exp_date date,
  description text,
  amount numeric(16,2) NOT NULL,
  billable boolean DEFAULT true,
  markup_pct numeric(6,2) DEFAULT '0',
  account_code text,
  vendor text,
  status text DEFAULT 'Open',            -- Open | Billed
  invoice_no text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS project_milestones (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  project_id bigint REFERENCES projects(id),
  name text NOT NULL,
  amount numeric(16,2) DEFAULT '0',
  due_date date,
  status text DEFAULT 'Pending',         -- Pending | Billed
  invoice_no text,
  billed_at timestamptz,
  created_at timestamptz DEFAULT now()
);
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
