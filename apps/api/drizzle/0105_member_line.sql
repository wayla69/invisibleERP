-- LINE OA member identity: link a POS member to a LINE account (LINE Login/LIFF `sub`).
ALTER TABLE pos_members ADD COLUMN IF NOT EXISTS line_user_id text;
ALTER TABLE pos_members ADD COLUMN IF NOT EXISTS line_display_name text;
-- One LINE account = one member per tenant. NULLs are distinct, so unlinked members never collide.
CREATE UNIQUE INDEX IF NOT EXISTS pos_members_tenant_line ON pos_members (tenant_id, line_user_id);
