-- 0234_signup_requests — approval-queue onboarding (ITGC-AC-18, onboarding-flow #3). A PUBLIC "request
-- access" form (POST /api/auth/signup-requests) creates a PENDING request — it does NOT provision a tenant.
-- A platform owner (@PlatformAdmin) then approves (→ provisions the company) or rejects it. Platform-level
-- (pre-tenant); the resolved tenant is `created_tenant_id` (NOT `tenant_id`, so the RLS loop never treats
-- this as a tenant-scoped table). The requester's chosen password is stored HASHED (scrypt), used on approve.
CREATE TABLE IF NOT EXISTS signup_requests (
  id bigserial PRIMARY KEY,
  company_name text NOT NULL,
  tenant_code text NOT NULL,
  admin_username text NOT NULL,
  password_hash text NOT NULL,
  email text NOT NULL,
  industry text,
  status text NOT NULL DEFAULT 'pending',
  reject_reason text,
  reviewed_by text,
  reviewed_at timestamptz,
  created_tenant_id bigint REFERENCES tenants(id),
  requested_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS signup_requests_status_idx ON signup_requests (status);
--> statement-breakpoint
-- Prevent duplicate PENDING requests for the same tenant code / username (approved/rejected rows don't block).
CREATE UNIQUE INDEX IF NOT EXISTS signup_requests_pending_code_idx ON signup_requests (tenant_code) WHERE status = 'pending';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS signup_requests_pending_user_idx ON signup_requests (admin_username) WHERE status = 'pending';
--> statement-breakpoint
-- app_user grants (interceptor runs under SET ROLE app_user). No RLS: platform-level, no tenant_id column.
DO $$ BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
END $$;
