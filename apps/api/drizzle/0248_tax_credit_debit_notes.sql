-- Credit note (ใบลดหนี้ · ม.86/10) + Debit note (ใบเพิ่มหนี้ · ม.86/9) as tax-invoice sibling types.
-- A seller issues these to ADJUST a previously-issued full tax invoice: a credit note REDUCES the sale +
-- output VAT (goods returned / price reduced / defect / post-sale discount); a debit note INCREASES it
-- (undercharge / added goods). Amounts are stored as the POSITIVE magnitude of the difference; the output-
-- VAT report signs them by type (credit_note −, debit_note +) for the ภ.พ.30 of the note's issue period.
-- Control (TAX-07): a note is issued as PendingApproval and posts a Draft GL entry; a DIFFERENT user
-- approves (GL-05 SoD), which flips the note to Issued AND posts the reversal to the GL. So the note's VAT
-- effect (report is status='Issued' only) and its GL effect land together, gated by maker-checker.
-- Reuses tax_invoices (already RLS-scoped) — ADD COLUMN only, so no RLS loop is required here.
ALTER TYPE "tax_invoice_type" ADD VALUE IF NOT EXISTS 'credit_note';
ALTER TYPE "tax_invoice_type" ADD VALUE IF NOT EXISTS 'debit_note';
ALTER TYPE "tax_invoice_status" ADD VALUE IF NOT EXISTS 'PendingApproval';
ALTER TABLE "tax_invoices" ADD COLUMN IF NOT EXISTS "original_doc_no" text;  -- ใบกำกับภาษีเดิมที่อ้างถึง (ม.86/10(3))
ALTER TABLE "tax_invoices" ADD COLUMN IF NOT EXISTS "reason" text;           -- เหตุผลการออกใบลดหนี้/เพิ่มหนี้
ALTER TABLE "tax_invoices" ADD COLUMN IF NOT EXISTS "gl_entry_no" text;      -- linked GL entry (Draft→Posted on approve)
