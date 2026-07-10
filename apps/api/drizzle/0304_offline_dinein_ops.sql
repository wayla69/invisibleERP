-- POS-6 — Offline dine-in ops. Extend the pos_offline_sync idempotency ledger so dine-in mutations
-- captured while the network is down (open table / add items / fire) replay idempotently on reconnect,
-- with SETTLEMENT staying online. No NEW table → the existing table-level GRANT + RLS (from 0028) already
-- cover these added columns, so no RLS loop / grant is needed here.
--   op_type    : null / 'sale' = a legacy quick-sale row (unchanged) ; 'dinein_open' | 'dinein_add' | 'dinein_fire'
--   order_no   : the dine-in order the op created (open) or targeted (add/fire) — server-minted DIN-…
--   order_uuid : client-generated offline-order key that links an open op to its later add/fire ops
ALTER TABLE pos_offline_sync ADD COLUMN IF NOT EXISTS op_type    text;
ALTER TABLE pos_offline_sync ADD COLUMN IF NOT EXISTS order_no   text;
ALTER TABLE pos_offline_sync ADD COLUMN IF NOT EXISTS order_uuid text;

-- add/fire ops resolve their target order by (tenant, order_uuid) → the synced open row's order_no.
CREATE INDEX IF NOT EXISTS pos_offline_sync_order_uuid ON pos_offline_sync (tenant_id, order_uuid);
