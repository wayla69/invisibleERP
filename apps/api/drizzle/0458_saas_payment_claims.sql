-- 0458_saas_payment_claims — Thai payment rails for the platform's own subscription billing (wave C).
-- One row per bank-transfer/PromptPay slip a tenant submits: Pending until a platform owner verifies the
-- transfer actually arrived — approve records the A4 saas_receipt (idempotent on 'claim:<id>') and
-- re-activates the subscription (the A2 dunning-recovery signal); reject emails the reason.
-- (about_tenant_id, slip_ref) UNIQUE stops the same slip being filed twice by one company.
-- Platform-level table: the company column is about_tenant_id (deliberately NOT tenant_id — the generic
-- RLS loop + tenant-index guard skip it, mirroring 0454 saas_receipts); tenant reads are explicitly
-- scoped in the service, god reads via the @PlatformAdmin bypass.
CREATE TABLE IF NOT EXISTS saas_payment_claims (
  id bigserial PRIMARY KEY,
  about_tenant_id bigint NOT NULL,   -- deliberately NOT named tenant_id (platform table)
  amount numeric(12,2) NOT NULL,     -- THB the customer says they transferred
  period text,                       -- YYYY-MM the payment is for
  slip_ref text NOT NULL,            -- bank/PromptPay transfer reference on the slip
  note text,
  status text NOT NULL DEFAULT 'Pending',  -- 'Pending' | 'Approved' | 'Rejected'
  receipt_no text,                   -- stamped on approve (the A4 receipt issued for this claim)
  reject_reason text,
  created_by text NOT NULL,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS saas_payment_claims_slip_uq ON saas_payment_claims (about_tenant_id, slip_ref);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS saas_payment_claims_tenant_idx ON saas_payment_claims (about_tenant_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS saas_payment_claims_status_idx ON saas_payment_claims (status, created_at);
--> statement-breakpoint
-- app_user grants (requests run under SET ROLE app_user). No RLS: platform-level, no tenant scoping.
DO $$ BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
END $$;
