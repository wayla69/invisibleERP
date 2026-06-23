-- 0077 — i18n (Phase 9): a per-tenant default language for customer-facing output (receipts, customer
-- display, diner QR). 'th' | 'en'. No new table → no RLS loop needed (tenants is already isolation-scoped).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS default_language text DEFAULT 'th';
