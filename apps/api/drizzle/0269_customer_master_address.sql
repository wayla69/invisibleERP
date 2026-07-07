-- 0269_customer_master_address — persist a buyer's address (encrypted at rest, like tax_id/notes on this
-- table) + branch_code on customer_master, so the "Issue full tax invoice" screen can search existing
-- customers and prefill the full ม.86/4 buyer block (name/tax_id/branch/address) instead of retyping it
-- every time. customer_master is already tenant-scoped (RLS via the generic loop) so a plain column-add
-- needs no RLS clause. address is not searched (ilike) anywhere, so it is safe to encrypt transparently
-- per the encryptedText convention (see database/encrypted-column.ts); branch_code stays plaintext (short,
-- non-sensitive, mirrors tenants.branch_code / tax_invoices.buyer_branch_code).
ALTER TABLE customer_master ADD COLUMN IF NOT EXISTS address text;
--> statement-breakpoint
ALTER TABLE customer_master ADD COLUMN IF NOT EXISTS branch_code text;
