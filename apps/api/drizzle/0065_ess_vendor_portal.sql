-- Phase D3 breadth — employee self-service (ESS) + supplier portal.
-- Link an employee / vendor to a login (by username) so a logged-in user can self-scope to ONLY their
-- own record, and add an expense-claims table for ESS reimbursements.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS user_name text;  -- ESS: employee ↔ users.username
ALTER TABLE vendors   ADD COLUMN IF NOT EXISTS user_name text;  -- supplier portal: vendor ↔ users.username
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS vendor_ack_at timestamp; -- supplier PO acknowledgement (status enum has no 'Acknowledged')
CREATE INDEX IF NOT EXISTS idx_employees_user ON employees(tenant_id, user_name);
CREATE INDEX IF NOT EXISTS idx_vendors_user ON vendors(tenant_id, user_name);

CREATE TABLE IF NOT EXISTS expense_claims (
  id          bigserial PRIMARY KEY,
  tenant_id   bigint REFERENCES tenants(id),
  employee_id bigint REFERENCES employees(id),
  claim_date  date,
  category    text,
  amount      numeric(14,2) NOT NULL DEFAULT 0,
  description text,
  status      text NOT NULL DEFAULT 'Pending',  -- Pending | Approved | Rejected
  decided_by  text,
  decided_at  timestamp,
  entry_no    text,                              -- GL JE on approval (Dr 5100 / Cr 2000)
  created_by  text,
  created_at  timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_expense_claims_tenant ON expense_claims(tenant_id);
CREATE INDEX IF NOT EXISTS idx_expense_claims_emp ON expense_claims(employee_id);
--> statement-breakpoint
-- Re-run the dynamic RLS loop so the new tenant_id table (expense_claims) is isolated like every other.
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
