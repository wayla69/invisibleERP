-- 0301_consolidation_cta_translation — FIN-5: CTA/OCI reserve + average-rate translation (consolidation).
-- Group consolidation historically translated every foreign entity at a single closing rate, so the
-- translated trial balance always netted to zero and no cumulative-translation-adjustment (CTA) ever arose —
-- a defect an IFRS/TFRS (TAS 21 / IAS 21) reviewer flags immediately. FIN-5 introduces dual-rate translation:
--  * P&L (revenue 4xxx / expense 5xxx) at the PERIOD AVERAGE rate,
--  * balance-sheet accounts at the CLOSING rate,
-- and parks the resulting translation difference in a CTA / OCI translation-reserve equity line (3400).
--
-- These two columns record, per consolidation run line, the FX rate used and its basis, so the dual-rate
-- translation and its CTA plug are fully auditable. consolidation_run_lines is keyed by run_id (no tenant_id
-- column — it is not tenant-scoped and carries no RLS policy), so this is a plain additive ALTER.
ALTER TABLE consolidation_run_lines ADD COLUMN IF NOT EXISTS fx_rate   numeric(18,8);
--> statement-breakpoint
ALTER TABLE consolidation_run_lines ADD COLUMN IF NOT EXISTS rate_type text;

--> statement-breakpoint
-- CTA / OCI translation-reserve equity account (parks the average-rate-P&L vs closing-rate-BS difference).
-- (3200 = revaluation surplus, 3300 = non-controlling interest are already seeded; 3400 is the OCI/CTA reserve.)
INSERT INTO accounts(code, name, type) VALUES
  ('3400', 'CTA / OCI Translation Reserve', 'Equity')
ON CONFLICT(code) DO NOTHING;
