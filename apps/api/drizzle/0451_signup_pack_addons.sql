-- 0451: /plans configurator follow-up — carry the prospect's pack selection through the signup request,
-- and per-tenant à-la-carte add-on entitlements.
-- signup_requests is a PLATFORM table (its tenant column is created_tenant_id, not tenant_id) — the
-- generic RLS loop never scopes it, so no RLS clause is needed for the new columns.
ALTER TABLE "signup_requests" ADD COLUMN IF NOT EXISTS "requested_plan" text;
ALTER TABLE "signup_requests" ADD COLUMN IF NOT EXISTS "requested_interval" text;
ALTER TABLE "signup_requests" ADD COLUMN IF NOT EXISTS "requested_addons" jsonb;
-- Purchased add-on suite keys (ADDON_KEYS in @ierp/shared entitlements), unioned into the tenant's
-- entitled suites by resolveEntitledSuites at request time; NULL = none.
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "addons" jsonb;
