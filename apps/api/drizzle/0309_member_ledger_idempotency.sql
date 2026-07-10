-- 0309 — Loyalty points ledger idempotency (control LYL-22; docs/41 Phase 2c-2 follow-up).
--
-- `pos_member_ledger` had NO uniqueness: replaying the same sale's earn/redeem (a retried checkout, a
-- store-hub replay, an integration retry) would deduct or award the points TWICE and write a second
-- ledger row. The only thing preventing it was the outer `pos_offline_sync` dedup — an external guard
-- the loyalty code itself never saw. Make the ledger safe on its own merits.
--
-- Scope: Earn/Redeem rows that carry a source document (`ref_doc`). Adjust/Transfer/Expire are
-- intentionally repeatable (a manager may adjust the same member twice on the same day) and a NULL
-- ref_doc row has no document identity, so both are excluded from the constraint.
--
-- Pre-existing duplicates (if any) would block the unique index, so they are collapsed first: keep the
-- earliest row per (tenant, member, ref_doc, txn_type) — it is the one whose balance_after the member
-- row was built from — and delete the later copies.
DELETE FROM pos_member_ledger a
USING pos_member_ledger b
WHERE a.ref_doc IS NOT NULL AND a.txn_type IN ('Earn','Redeem')
  AND b.ref_doc = a.ref_doc AND b.txn_type = a.txn_type
  AND b.member_id = a.member_id AND b.tenant_id IS NOT DISTINCT FROM a.tenant_id
  AND b.id < a.id;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_member_ledger_doc
  ON pos_member_ledger (tenant_id, member_id, ref_doc, txn_type)
  WHERE ref_doc IS NOT NULL AND txn_type IN ('Earn','Redeem');
