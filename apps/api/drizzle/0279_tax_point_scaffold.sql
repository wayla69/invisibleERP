-- 0279 — Wave 2 · 5.1a VAT tax-point scaffolding (INERT — no behaviour change).
-- Adds supply_type to the shared `items` master (default 'goods') and tax_point_date + supply_type to
-- `tax_invoices`, backfilling tax_point_date = issue_date for existing rows so every report is unchanged.
-- Nothing reads or writes these in a decision path yet — that is 5.1b (stamp at issue) / 5.1c (report
-- bucketing) / 5.1e (installment) and is gated on the tax-advisor sign-off. `items` has NO tenant_id
-- (shared master) so no RLS loop is needed; `tax_invoices` is already RLS-scoped and a column add inherits
-- the existing table grant. Verified against ประมวลรัษฎากร ม.78 / 78/1. See docs/37-tax-point-model-design.md.
ALTER TABLE items ADD COLUMN IF NOT EXISTS supply_type text NOT NULL DEFAULT 'goods';
ALTER TABLE tax_invoices ADD COLUMN IF NOT EXISTS tax_point_date date;
ALTER TABLE tax_invoices ADD COLUMN IF NOT EXISTS supply_type text;
UPDATE tax_invoices SET tax_point_date = issue_date WHERE tax_point_date IS NULL;
