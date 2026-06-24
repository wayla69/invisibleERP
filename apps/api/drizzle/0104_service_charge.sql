-- 0104 — Service charge on receipts. The large-party dine-in service charge is already computed and
-- posted to GL 4400, but was not persisted on the sale header, so the receipt could not itemise it.
-- Persist it on cust_pos_sales so the receipt shows a ค่าบริการ (service charge) line and the REST-10
-- receipt↔fiscal tie-out can reconcile it. Existing table (already RLS-scoped) → no RLS loop needed;
-- retail/portal sales keep the 0 default, so totals are unchanged for them.
ALTER TABLE cust_pos_sales ADD COLUMN IF NOT EXISTS service_charge numeric(14,2) DEFAULT '0';
--> statement-breakpoint
