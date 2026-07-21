-- 0452_platform_emails — outbound transactional-email outbox (A1: real-world Platform Console wave 1).
-- Every customer-facing platform email (signup approval/rejection, invite link, trial reminder, payment
-- failed, suspension notice) is recorded here first (Queued) and delivered by the background job worker
-- ('platform_email' job) or the god deliver-pending endpoint; Sent/Failed + provider evidence make this
-- the audit trail for platform mail. Platform-level table: the company column is about_tenant_id
-- (deliberately NOT tenant_id, so the generic RLS loop + tenant-index guard skip it — mirrors 0247
-- platform_notifications); only gods read it via the @PlatformAdmin bypass.
CREATE TABLE IF NOT EXISTS platform_emails (
  id bigserial PRIMARY KEY,
  template text NOT NULL,             -- 'signup_approved' | 'signup_rejected' | 'signup_invite' | 'trial_reminder' | 'payment_failed' | 'company_suspended'
  to_email text NOT NULL,
  lang text NOT NULL DEFAULT 'th',
  subject text NOT NULL,
  vars jsonb,                         -- template variables (rendered again at delivery)
  status text NOT NULL DEFAULT 'Queued', -- 'Queued' | 'Sent' | 'Failed'
  provider text,                      -- 'mock' | 'resend' | 'postmark' (stamped at delivery)
  provider_msg_id text,
  error text,
  about_tenant_id bigint,             -- which company it concerns (nullable); deliberately NOT named tenant_id
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS platform_emails_created_idx ON platform_emails (created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS platform_emails_status_idx ON platform_emails (status);
--> statement-breakpoint
-- app_user grants (requests run under SET ROLE app_user). No RLS: platform-level, no tenant scoping.
DO $$ BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
END $$;
