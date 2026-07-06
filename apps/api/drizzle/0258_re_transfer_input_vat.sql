-- 0258_re_transfer_input_vat — docs/35 P5 + Depth. (1) Real-estate ownership transfer (RE-04): a unit carries
-- a construction cost, and a fully-settled contract can be transferred → revenue recognised (contract
-- liability 2410 → revenue 4200) and the unit cost relieved (5800 ← inventory 1200). (2) Subcontractor INPUT
-- VAT: a subcontract carries a vat_pct so the certified valuation books recoverable input VAT (Dr 1300).
-- Column-adds only (tables already carry RLS) → no policy loop.
ALTER TABLE re_units ADD COLUMN IF NOT EXISTS cost numeric(16,2) NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE re_contracts ADD COLUMN IF NOT EXISTS transfer_entry_no text;
--> statement-breakpoint
ALTER TABLE re_contracts ADD COLUMN IF NOT EXISTS transferred_at timestamptz;
--> statement-breakpoint
ALTER TABLE project_subcontracts ADD COLUMN IF NOT EXISTS vat_pct numeric(9,4) NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE subcontract_valuations ADD COLUMN IF NOT EXISTS vat_amount numeric(16,2) NOT NULL DEFAULT 0;
