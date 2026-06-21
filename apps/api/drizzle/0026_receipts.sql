-- POS Tier 2 #8 — receipt reprint audit (ใบเสร็จ). No GL. RLS via the 0002 DO-block re-run at tail.
CREATE TABLE IF NOT EXISTS receipt_prints (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  sale_no text NOT NULL,
  channel text NOT NULL DEFAULT 'print',
  is_copy text NOT NULL DEFAULT 'false',
  printed_by text,
  printed_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS receipt_prints_sale ON receipt_prints (sale_no);

-- Re-run the 0002 RLS loop so receipt_prints (has tenant_id) is isolation-scoped.
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
