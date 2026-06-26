-- B1 — Table reservations + walk-in waitlist. One table covers both a future booking
-- (kind='reservation', reserved_for set) and a walk-in queue entry (kind='waitlist', reserved_for null);
-- both notify the guest (LINE/SMS) when ready and seat to a table. No GL (operational scheduling).
CREATE TYPE reservation_status AS ENUM ('booked', 'waiting', 'ready', 'seated', 'cancelled', 'no_show');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS table_reservations (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  kind text NOT NULL DEFAULT 'reservation',           -- 'reservation' | 'waitlist'
  table_id bigint REFERENCES dining_tables(id),        -- optional assigned table
  reserved_for timestamptz,                            -- booking time (null for walk-in waitlist)
  party_size integer NOT NULL DEFAULT 2,
  customer_name text,
  customer_phone text,
  member_id bigint REFERENCES pos_members(id),         -- optional loyalty link
  status reservation_status NOT NULL DEFAULT 'booked',
  quoted_wait_min integer,
  notes text,
  notified_at timestamptz,
  seated_at timestamptz,
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_table_reservations_status ON table_reservations (tenant_id, status, kind);
--> statement-breakpoint
-- Re-run the RLS loop so the new tenant_id table is isolation-scoped (idempotent — DROP POLICY IF EXISTS).
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
