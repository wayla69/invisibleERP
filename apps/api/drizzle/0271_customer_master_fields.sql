-- 0271_customer_master_fields — master-data audit Phase 3: customer_master was missing several Oracle/
-- NetSuite-grade Must-have fields (credit terms, sales rep, category, preferred language, external system
-- reference) and had NO web CRUD screen at all (only invoice-issuance auto-upsert + a member/account link
-- endpoint). This migration adds the scalar columns; multi-address/multi-contact/parent-hierarchy depth is
-- deliberately deferred to a future relational Party-model phase (docs/audit — Phase 4), not scalar columns.
ALTER TABLE customer_master ADD COLUMN IF NOT EXISTS credit_terms text;
--> statement-breakpoint
ALTER TABLE customer_master ADD COLUMN IF NOT EXISTS sales_rep text;
--> statement-breakpoint
ALTER TABLE customer_master ADD COLUMN IF NOT EXISTS category text;
--> statement-breakpoint
ALTER TABLE customer_master ADD COLUMN IF NOT EXISTS language text DEFAULT 'th';
--> statement-breakpoint
ALTER TABLE customer_master ADD COLUMN IF NOT EXISTS external_ref text;
