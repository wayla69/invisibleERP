-- 0218_loyalty_worldclass_w1 — docs/27 Phase W1: tier economics + points liquidity.
-- (a) loyalty_config.transfer_day_cap — per-member daily cap on outgoing P2P point transfers (LYL-18);
--     0 disables the transfer feature entirely. The tier earn multiplier itself needs NO schema change —
--     loyalty_tiers.earn_mult has existed since the tier ladder shipped; W1 makes earnInTx honour it.
-- (b) loyalty_expiry_notices — idempotency register for the loyalty.points_expiring look-ahead event
--     (one notice per member × expire-by date, so a daily sweep never re-nags the same expiring batch).
-- Tenant-scoped table → re-run the RLS loop. Mirrors 0207_loyalty_receipt_submissions.
ALTER TABLE loyalty_config ADD COLUMN IF NOT EXISTS transfer_day_cap integer NOT NULL DEFAULT 1000;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS loyalty_expiry_notices (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  member_id bigint NOT NULL REFERENCES pos_members(id),
  expire_by date NOT NULL,
  expiring_points numeric(14,2) NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_expiry_notices_member_window ON loyalty_expiry_notices (member_id, expire_by);
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
