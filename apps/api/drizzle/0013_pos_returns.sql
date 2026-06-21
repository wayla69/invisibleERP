-- POS Tier 1 #5 — item-level returns/refunds with restock + credit-note hook.
CREATE TABLE IF NOT EXISTS pos_returns (
  id bigserial PRIMARY KEY,
  return_no text NOT NULL UNIQUE,
  tenant_id bigint REFERENCES tenants(id),
  sale_no text NOT NULL,
  payment_no text,
  refund_no text,
  refund_method text DEFAULT 'Cash',
  return_date date,
  reason text,
  subtotal_returned numeric(14,2) DEFAULT 0,
  vat_returned numeric(14,2) DEFAULT 0,
  total_returned numeric(14,2) DEFAULT 0,
  restocked boolean DEFAULT false,
  journal_no text,
  credit_note_no text,
  status text DEFAULT 'Completed',
  created_by text,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pos_return_items (
  id bigserial PRIMARY KEY,
  return_id bigint REFERENCES pos_returns(id),
  tenant_id bigint REFERENCES tenants(id),
  sale_item_id bigint,
  item_id text,
  item_description text,
  return_qty numeric NOT NULL,
  uom text,
  unit_price numeric(14,2),
  amount numeric(14,2),
  restocked boolean DEFAULT false
);
CREATE INDEX IF NOT EXISTS pos_returns_sale_no ON pos_returns (sale_no);
CREATE INDEX IF NOT EXISTS pos_return_items_return ON pos_return_items (return_id);

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
