-- 0393_tenant_soft_delete — Platform Console company deletion (god-only). A lighter-weight lifecycle
-- action than the 0257 factory-reset: it flags the tenant row itself as deleted WITHOUT touching any
-- business data (unlike factory-reset, which wipes tenant-scoped tables but keeps the tenant row alive).
-- deleted_at != null hides the company from the fleet list/company-switcher and PERMANENTLY blocks its
-- users at the auth guard (TENANT_DELETED) independent of suspended_at — so a stray reactivate can never
-- silently re-open a deleted company's logins. Reversible via restoreTenant (clears the flag; the company
-- stays suspended until a separate reactivate). Columns on the existing `tenants` table (self-policy +
-- app_user grants already in place, mirrors 0235_tenant_lifecycle). Idempotent; PGlite + Postgres alike.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
--> statement-breakpoint
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS deleted_by text;
