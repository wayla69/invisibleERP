-- 0233_signup_invites — invite-link onboarding (ITGC-AC-18, onboarding-flow #2). A platform owner
-- (@PlatformAdmin, POST /api/admin/signup-invites) issues a single-use, expiring invite; the PUBLIC signup
-- endpoint accepts a valid invite token to provision ONE company even when public signup is disabled.
-- Platform-level (pre-tenant, NO tenant_id → no RLS, like `plans`). Only the token HASH is stored (the raw
-- token is returned once at creation). Consumed atomically via the `used_at IS NULL` guard → single-use.
CREATE TABLE IF NOT EXISTS signup_invites (
  id bigserial PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  created_by text NOT NULL,
  company_name text,
  plan_code text,
  email text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_tenant_id bigint REFERENCES tenants(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS signup_invites_expires_idx ON signup_invites (expires_at);
--> statement-breakpoint
-- app_user needs table/sequence grants (the interceptor runs under SET ROLE app_user). No RLS: signup_invites
-- has no tenant_id (platform-level), so the tenant_isolation loop intentionally does not touch it.
DO $$ BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
END $$;
