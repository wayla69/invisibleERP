-- 0115 — AP disbursement maker-checker (AP-PAY control). A vendor payment is now a two-step,
-- segregated flow: a `creditors` holder REQUESTS a payment (PendingApproval, no cash/GL effect yet) and a
-- DIFFERENT user holding approval authority APPROVES it — only then is the bill's paid_amount incremented
-- and the cash-disbursement GL posted. Mirrors GL-05 (manual JE maker-checker). New tenant_id table → RLS loop.
CREATE TABLE IF NOT EXISTS ap_payments (
  id bigserial PRIMARY KEY,
  payment_no text NOT NULL UNIQUE,            -- APP-YYYYMMDD-NNN
  txn_no text NOT NULL,                        -- → ap_transactions.txn_no
  tenant_id bigint REFERENCES tenants(id),
  amount numeric(14,2) NOT NULL,
  status text NOT NULL DEFAULT 'PendingApproval', -- PendingApproval | Approved | Rejected
  requested_by text,
  requested_at timestamptz DEFAULT now(),
  approved_by text,
  approved_at timestamptz,
  reject_reason text,
  gl_ref text,                                 -- PAY-AP source_ref used at approval (idempotent GL post)
  idempotency_key text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ap_payments_txn ON ap_payments (txn_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ap_payments_status ON ap_payments (tenant_id, status);
--> statement-breakpoint
-- Idempotency: a retried request carrying the same key collapses to the original (no duplicate disbursement).
CREATE UNIQUE INDEX IF NOT EXISTS ux_ap_payments_idem ON ap_payments (coalesce(tenant_id, 0), idempotency_key)
  WHERE idempotency_key IS NOT NULL;
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
