-- POS Tier 2 #11 — Offline mode / sync (โหมดออฟไลน์ + ซิงค์).
-- Idempotency ledger for replayed offline sales. No NEW GL accounts — sales post through the existing
-- portal createSale path (Dr 1000 / Cr 4000 / Cr 2100). RLS via the 0002 DO-block re-run at tail.
DO $$ BEGIN CREATE TYPE offline_sync_status AS ENUM ('synced','duplicate','failed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS pos_offline_sync (
  id            bigserial PRIMARY KEY,
  tenant_id     bigint REFERENCES tenants(id),
  client_uuid   text NOT NULL,
  device_id     text,
  status        offline_sync_status NOT NULL DEFAULT 'synced',
  sale_no       text,
  captured_at   timestamptz NOT NULL,
  synced_at     timestamptz NOT NULL DEFAULT now(),
  client_seq    bigint,
  payload_hash  text,
  error_code    text,
  error_message text,
  attempts      integer NOT NULL DEFAULT 1,
  created_by    text,
  created_at    timestamptz DEFAULT now()
);
-- the idempotency gate: one op per (tenant, client_uuid)
CREATE UNIQUE INDEX IF NOT EXISTS pos_offline_sync_uuid ON pos_offline_sync (tenant_id, client_uuid);
CREATE INDEX IF NOT EXISTS pos_offline_sync_device ON pos_offline_sync (tenant_id, device_id, client_seq);

-- Re-run the 0002 RLS loop so pos_offline_sync (tenant_id) is isolation-scoped.
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
