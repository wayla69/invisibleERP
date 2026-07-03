-- 0235_tenant_lifecycle — suspend/reactivate a company (ITGC-AC-18, onboarding-flow #5). A platform owner
-- (@PlatformAdmin) can SUSPEND a tenant: its users are then blocked at the auth guard (403 TENANT_SUSPENDED),
-- and REACTIVATE restores access. Platform owners are exempt from the block so they can always reactivate.
-- Columns on the existing `tenants` table (which has its own self-policy; app_user grants already in place).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
--> statement-breakpoint
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS suspended_by text;
--> statement-breakpoint
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS suspend_reason text;
