-- Review W3 — client idempotency keys for AR receipts and AP bills, so a retried request (a second HTTP
-- call after a timeout) cannot double-post cash / duplicate a payable. Both tables are tenant-scoped (RLS
-- already applies); a partial unique index dedups per tenant when a key is supplied.
ALTER TABLE ar_receipts    ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE ap_transactions ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS ux_ar_receipts_idem ON ar_receipts(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_ap_txn_idem ON ap_transactions(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
