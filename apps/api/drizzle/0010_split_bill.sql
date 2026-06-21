-- POS Tier 1 #2 — Split bill (แยกบิล) check grouping + partially_paid order state.
ALTER TYPE dine_in_order_status ADD VALUE IF NOT EXISTS 'partially_paid';

CREATE TABLE IF NOT EXISTS pos_check_splits (
  id bigserial PRIMARY KEY,
  group_no text NOT NULL,
  tenant_id bigint REFERENCES tenants(id),
  order_no text NOT NULL,
  check_seq int NOT NULL,
  sale_no text NOT NULL,
  method text NOT NULL,
  total numeric(14,2),
  status text DEFAULT 'Paid',
  created_by text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pos_check_splits_order ON pos_check_splits (order_no);
CREATE UNIQUE INDEX IF NOT EXISTS pos_check_splits_group_seq ON pos_check_splits (group_no, check_seq);

-- Re-run the 0002 RLS loop so pos_check_splits is isolation-scoped.
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
