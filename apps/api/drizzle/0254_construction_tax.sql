-- 0254_construction_tax — Depth-2/3 (docs/35). Tax on the construction billing chain: OUTPUT VAT on customer
-- progress claims, and WITHHOLDING TAX (WHT, ภ.ง.ด.53) on subcontractor valuations. Column-adds only (the
-- tables already carry RLS from 0250/0251), so no policy loop is needed.
ALTER TABLE project_progress_claims ADD COLUMN IF NOT EXISTS vat_pct numeric(9,4) NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE project_progress_claims ADD COLUMN IF NOT EXISTS vat_amount numeric(16,2) NOT NULL DEFAULT 0;
--> statement-breakpoint
-- rev_method snapshot on the claim so the certification posting can reconcile with the POC engine.
ALTER TABLE project_progress_claims ADD COLUMN IF NOT EXISTS rev_method text NOT NULL DEFAULT 'billing';
--> statement-breakpoint
ALTER TABLE project_subcontracts ADD COLUMN IF NOT EXISTS wht_pct numeric(9,4) NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE subcontract_valuations ADD COLUMN IF NOT EXISTS wht_amount numeric(16,2) NOT NULL DEFAULT 0;
