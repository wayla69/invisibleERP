-- 0287: API-key minter identity (security review H-2). Record the human who issued each API key so the
-- auth guard can bind the key principal's identity to that person for maker-checker/SoD — a key can no
-- longer be used to self-approve the minter's own work (create-with-key / approve-with-key). NULL for
-- legacy keys (issued before this column) → the guard falls back to the `apikey:<prefix>` machine identity.
-- api_keys already has tenant_id (RLS-scoped) and app_user table grants; a new column inherits both, so no
-- RLS-loop or GRANT change is needed.
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "created_by" text;
