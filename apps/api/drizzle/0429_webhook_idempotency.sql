-- 0429_webhook_idempotency — SOX-ICFR audit finding #5 (webhook replay attacks on payments & delivery).
-- A reusable, PLATFORM-LEVEL idempotency ledger for inbound webhooks. HMAC + a replay-window (timestamp)
-- prove authenticity and bound how *long* a captured request survives, but they do NOT stop a duplicate
-- being processed WITHIN the window (a redelivered PSP "captured" or a re-sent settlement callback). This
-- table makes a webhook event single-shot: the first delivery claims (source, idem_key) and processes; any
-- later delivery of the same key is acked as a duplicate and never re-runs the side effect (double GL post /
-- double settlement). The unique index is the single source of truth, so two concurrent redeliveries can
-- never both win.
--
-- PLATFORM-LEVEL (no RLS): the dedup key is globally unique per source, so there is intentionally no
-- `tenant_id` column (which would force RLS + the tenant-idx gate and require tenant context at claim time,
-- while several webhook handlers run @NoTx pre-tenant). `about_tenant_id` is informational only (which
-- tenant the event concerned) and, per the platform-table convention, is deliberately NOT named `tenant_id`
-- so the generic RLS loop and the AUD-ARC-01 tenant-idx gate both skip this table. Grant app_user directly.
CREATE TABLE IF NOT EXISTS webhook_idempotency (
  id bigserial PRIMARY KEY,
  source text NOT NULL,               -- webhook family, e.g. 'promptpay', 'psp:opn'
  idem_key text NOT NULL,             -- provider event id, or a sha256 content-hash of the raw body
  about_tenant_id bigint REFERENCES tenants(id),  -- informational (NOT a tenant-scoping column — see header)
  received_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_idempotency ON webhook_idempotency (source, idem_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_webhook_idempotency_received ON webhook_idempotency (received_at);
--> statement-breakpoint
-- app_user grants (platform table, no RLS clause needed — mirrors 0234/0247 platform tables).
DO $$ BEGIN
  EXECUTE 'GRANT SELECT, INSERT, DELETE ON webhook_idempotency TO app_user';
  EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE webhook_idempotency_id_seq TO app_user';
END $$;
