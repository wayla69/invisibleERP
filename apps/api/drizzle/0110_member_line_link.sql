-- 0110 — CRM Phase 4: link a LINE account to a member for LINE LIFF login. Adds a column to the existing
-- (already RLS-scoped) pos_members table — no RLS-loop re-run needed.
ALTER TABLE pos_members ADD COLUMN IF NOT EXISTS line_user_id text;
--> statement-breakpoint
-- One LINE account ↔ at most one member per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS pos_members_tenant_line ON pos_members (tenant_id, line_user_id) WHERE line_user_id IS NOT NULL;
