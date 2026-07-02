-- 0210_message_log_provider_ref — Phase E2: store the provider's message id on each outbound message so an
-- inbound delivery-status callback can correlate it and update the row's status (sent → delivered/undelivered).
-- Additive nullable column on an existing tenant-scoped table (RLS already applies); no RLS loop needed.
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS provider_ref text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_message_log_provider_ref ON message_log (tenant_id, provider_ref);
