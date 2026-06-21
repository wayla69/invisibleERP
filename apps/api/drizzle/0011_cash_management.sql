-- POS Tier 1 #3: Cash management — paid-in/paid-out/drop on an open till + denomination count.
DO $$ BEGIN CREATE TYPE cash_movement_type AS ENUM ('paid_in','paid_out','drop');
  EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS cash_movements (
  id bigserial PRIMARY KEY,
  movement_no text NOT NULL UNIQUE,
  tenant_id bigint REFERENCES tenants(id),
  till_session_id bigint NOT NULL,
  type cash_movement_type NOT NULL,
  amount numeric(18,4) NOT NULL,
  reason text,
  journal_no text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cash_movements_till ON cash_movements (till_session_id, type);

ALTER TABLE till_sessions ADD COLUMN IF NOT EXISTS denominations jsonb;

-- Re-run the 0002 RLS loop so cash_movements (tenant_id) is isolation-scoped.
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
