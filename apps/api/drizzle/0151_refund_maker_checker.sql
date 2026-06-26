-- W2 — Refund maker-checker (REV-16). A standalone payment refund at/above the materiality threshold is a
-- REQUEST that moves no money until a DIFFERENT user approves it (SoD); sub-threshold refunds run
-- immediately, and a refund that is part of a goods-return (the return is the authorizing document) is
-- never gated.
CREATE TABLE IF NOT EXISTS refund_requests (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  payment_no text NOT NULL,
  amount numeric(18,4) NOT NULL,
  reason text,
  status text NOT NULL DEFAULT 'PendingApproval',
  requested_by text,
  approved_by text,
  refund_no text,
  created_at timestamptz DEFAULT now(),
  approved_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_refund_requests_status ON refund_requests (tenant_id, status);
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
