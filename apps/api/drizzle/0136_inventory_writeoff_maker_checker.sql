-- 0136 — Inventory write-off maker-checker (INV-07). A stock write-off (a NEGATIVE adjustment) is now a
-- REQUEST that posts NOTHING — no variance JE, no layer consumption, no balance change — until a DIFFERENT
-- user approves. On approval the real valued adjustment runs atomically against current state (consumes
-- FIFO/FEFO layers, posts Dr 5810 / Cr 1200, moves the balance). This is the theft-concealment / SoD control
-- over inventory: one person can no longer write stock off the books to cover a shortage they caused.
CREATE TABLE IF NOT EXISTS inv_writeoff_requests (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  item_id text NOT NULL,
  location_id text NOT NULL DEFAULT 'WH-MAIN',
  qty_delta numeric(18,4) NOT NULL,                 -- negative (a write-off)
  est_value numeric(18,4) NOT NULL DEFAULT 0,        -- estimate at request time (|delta| × avg), display only
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'PendingApproval',    -- PendingApproval | Posted | Rejected
  requested_by text,
  approved_by text,                                  -- checker — must differ from requested_by
  move_no text,                                       -- the resulting inv_move once approved
  gl_entry_no text,
  created_at timestamptz DEFAULT now(),
  approved_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_inv_writeoff_status ON inv_writeoff_requests (tenant_id, status);

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
