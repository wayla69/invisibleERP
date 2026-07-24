-- 0425_psp_terminal_depth — C5 (docs/50 Wave 5, re-scoped): the genuine residual of "real PSP card
-- terminal". The provider framework, Omise acquirer, pre-auth/capture/void/refund lifecycle, HMAC+replay
-- webhook and settlement batching pre-exist (pos-terminal.*, 0263-era) — what was missing:
--   1. PSP EVENT-ID idempotency: a redelivered webhook event (same event id, possibly stale status) could
--      re-process; psp_webhook_events dedupes per (provider, event_id).
--   2. REAL settlement reconciliation: reconcile() was a status flip — settlement_lines stores the imported
--      acquirer report matched per intent (matched / amount_mismatch / missing_intent / unreported_intent),
--      and the batch carries reconciled_amount + discrepancy_count.
--   3. Tip-on-terminal: payment_intents.tip_amount (charge-time tip, or the classic capture-time tip
--      adjustment on a bar-tab pre-auth).
ALTER TABLE "payment_intents" ADD COLUMN IF NOT EXISTS "tip_amount" numeric(14,2) DEFAULT '0';
--> statement-breakpoint
ALTER TABLE "settlement_batches" ADD COLUMN IF NOT EXISTS "reconciled_amount" numeric(14,2);
--> statement-breakpoint
ALTER TABLE "settlement_batches" ADD COLUMN IF NOT EXISTS "discrepancy_count" integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "settlement_batches" ADD COLUMN IF NOT EXISTS "reconciled_at" timestamptz;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS psp_webhook_events (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  provider text NOT NULL,
  event_id text NOT NULL,
  provider_ref text,
  status text,
  outcome text,
  received_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_psp_webhook_events ON psp_webhook_events (provider, event_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_psp_webhook_events_tenant ON psp_webhook_events (tenant_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS settlement_lines (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  batch_no text NOT NULL,
  provider_ref text,
  intent_no text,
  amount numeric(14,2) DEFAULT '0',
  fee numeric(14,2) DEFAULT '0',
  match_status text NOT NULL DEFAULT 'matched',  -- matched | amount_mismatch | missing_intent | unreported_intent
  note text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_settlement_lines_tenant ON settlement_lines (tenant_id, batch_no);
--> statement-breakpoint

-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form). Idempotent.
DO $$ DECLARE r record; BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I'
      || ' USING (coalesce(current_setting(''app.bypass_rls'', true), '''') = ''on'''
      || '        OR tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint'
      || '        OR (nullif(current_setting(''app.org_id'', true), '''') IS NOT NULL'
      || '            AND tenant_id IN (SELECT id FROM tenants WHERE org_id = nullif(current_setting(''app.org_id'', true), '''')::bigint)))'
      || ' WITH CHECK (coalesce(current_setting(''app.bypass_rls'', true), '''') = ''on'''
      || '        OR tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint'
      || '        OR (nullif(current_setting(''app.org_id'', true), '''') IS NOT NULL'
      || '            AND tenant_id IN (SELECT id FROM tenants WHERE org_id = nullif(current_setting(''app.org_id'', true), '''')::bigint)))',
      r.table_name);
  END LOOP;
END $$;
