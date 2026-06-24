-- 0084 — Outbound webhook dispatch + delivery audit (Platform Phase 8). The webhooks / webhook_deliveries
-- tables and signed delivery already exist (0001); this adds the columns the new delivery log, retry and
-- redeliver need, plus query indexes. Additive ALTERs only — no new tenant_id table, so no RLS loop
-- (webhooks is already tenant-scoped; webhook_deliveries is scoped via its FK join to webhooks).

ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS created_by text;
--> statement-breakpoint
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS error text;
--> statement-breakpoint
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;
--> statement-breakpoint
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_webhooks_scope ON webhooks (tenant_id, active);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_hook ON webhook_deliveries (webhook_id, status);
