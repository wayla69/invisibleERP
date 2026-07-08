-- 0285_re_sbt (5.5, TAX-09): ภาษีธุรกิจเฉพาะ (Specific Business Tax) on commercial immovable-property sales
-- (ประมวลรัษฎากร ม.91/2(6) — 3% + 10% local tax = 3.3% effective), filed monthly on ภ.ธ.40 by the 15th.
-- DEFAULT-INERT: re_projects.sbt_rate is NULL (no accrual — legacy behaviour) until a DPO/controller sets it
-- per project; a transfer then accrues Dr 5840 SBT expense / Cr 2130 SBT payable and stamps the contract.
ALTER TABLE re_projects ADD COLUMN IF NOT EXISTS sbt_rate NUMERIC(5,2);
--> statement-breakpoint
ALTER TABLE re_contracts ADD COLUMN IF NOT EXISTS sbt_rate NUMERIC(5,2);
--> statement-breakpoint
ALTER TABLE re_contracts ADD COLUMN IF NOT EXISTS sbt_amount NUMERIC(16,2);
