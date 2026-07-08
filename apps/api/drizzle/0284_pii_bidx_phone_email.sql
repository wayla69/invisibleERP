-- 0284_pii_bidx_phone_email (PII-at-rest rollout, docs/ops/pii-encryption-rollout.md): pos_members.phone/
-- email and customer_master.phone/email move to encryptedText (application-layer AES-256-GCM, see
-- database/encrypted-column.ts). A random per-row IV means the ciphertext can no longer be matched by SQL
-- equality/ilike, so each column gets a companion `_bidx` (blindIndex()) column carrying a deterministic
-- HMAC of the normalized value for EXACT-MATCH lookup only — substring search on phone/email is retired
-- (accepted product tradeoff; name/card_no/member_code/customer_no substring search is unaffected).
-- The columns themselves stay `text` (ciphertext at rest is opaque to Postgres) — no ALTER TYPE needed;
-- existing plaintext rows keep reading correctly via encryptedText's legacy-plaintext passthrough until the
-- backfill script (database/backfill-encrypt-pii.ts) rewrites them and populates the new bidx columns.
ALTER TABLE pos_members ADD COLUMN IF NOT EXISTS phone_bidx text;
ALTER TABLE pos_members ADD COLUMN IF NOT EXISTS email_bidx text;
ALTER TABLE customer_master ADD COLUMN IF NOT EXISTS phone_bidx text;
ALTER TABLE customer_master ADD COLUMN IF NOT EXISTS email_bidx text;
--> statement-breakpoint

-- The old plaintext unique index no longer enforces anything once `phone` is ciphertext (a random IV makes
-- every row's value unique regardless of the underlying phone number) — replace it with a unique index on
-- the bidx, which preserves the original "one phone per tenant" invariant.
DROP INDEX IF EXISTS pos_members_tenant_phone;
CREATE UNIQUE INDEX IF NOT EXISTS pos_members_tenant_phone_bidx ON pos_members (tenant_id, phone_bidx) WHERE phone_bidx IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_customer_master_phone_bidx ON customer_master (tenant_id, phone_bidx);
CREATE INDEX IF NOT EXISTS idx_customer_master_email_bidx ON customer_master (tenant_id, email_bidx);
