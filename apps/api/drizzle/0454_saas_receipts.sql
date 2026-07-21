-- 0454_saas_receipts — own-SaaS receipt ledger (A4: real-world Platform Console wave 1). One row per
-- subscription payment the PLATFORM collects (Stripe invoice.paid webhook, or a god-recorded bank
-- transfer): receipt number, VAT-inclusive amount (+ 7/107 breakdown when the issuer is VAT-registered),
-- the covering period, and full attribution. source_ref is UNIQUE — a re-delivered webhook or retried
-- manual record converges to one receipt. Platform-level table: the company column is about_tenant_id
-- (deliberately NOT tenant_id — the generic RLS loop + tenant-index guard skip it, mirroring 0452/0453);
-- tenants read ONLY their own rows through the service (explicit about_tenant_id filter), gods read all.
CREATE TABLE IF NOT EXISTS saas_receipts (
  id bigserial PRIMARY KEY,
  receipt_no text NOT NULL,
  about_tenant_id bigint NOT NULL,    -- deliberately NOT named tenant_id (platform table)
  source text NOT NULL,               -- 'stripe_invoice' | 'manual'
  source_ref text NOT NULL,           -- stripe invoice id, or MANUAL-<uuid>
  period text,                        -- YYYY-MM (best effort)
  amount numeric(14,2) NOT NULL,      -- VAT-inclusive THB
  vat_amount numeric(14,2),           -- 7/107 breakdown; NULL = plain receipt (issuer not VAT-registered)
  currency text NOT NULL DEFAULT 'THB',
  note text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS saas_receipts_source_ref_uq ON saas_receipts (source_ref);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS saas_receipts_no_uq ON saas_receipts (receipt_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS saas_receipts_tenant_idx ON saas_receipts (about_tenant_id, created_at);
--> statement-breakpoint
-- app_user grants (requests run under SET ROLE app_user). No RLS: platform-level, no tenant scoping.
DO $$ BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
END $$;
