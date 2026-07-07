-- 0268_tax_invoice_payment_fields — presentation/data fields to bring the ใบกำกับภาษีเต็มรูป (ม.86/4) closer
-- to a combined ใบเสร็จรับเงิน/ใบกำกับภาษี layout: a payment-due date and the "ชำระเงินโดย" (Paid By) block
-- (method + bank/cheque/branch, for a paid-by-transfer or paid-by-cheque receipt). None of these are
-- ม.86/4-mandatory particulars — they are optional, presentation-adjacent fields. tax_invoices is already
-- tenant-scoped (RLS via the generic loop) so a plain column-add needs no RLS clause. tenants.fax is a
-- contact-info field (mirrors the existing tenants.phone) read live (like logo_url) — not a frozen legal
-- snapshot column, so it lives on tenants, not tax_invoices.
ALTER TABLE tax_invoices ADD COLUMN IF NOT EXISTS due_date date;
--> statement-breakpoint
ALTER TABLE tax_invoices ADD COLUMN IF NOT EXISTS paid_by text;
--> statement-breakpoint
ALTER TABLE tax_invoices ADD COLUMN IF NOT EXISTS paid_by_other text;
--> statement-breakpoint
ALTER TABLE tax_invoices ADD COLUMN IF NOT EXISTS paid_bank text;
--> statement-breakpoint
ALTER TABLE tax_invoices ADD COLUMN IF NOT EXISTS paid_cheque_no text;
--> statement-breakpoint
ALTER TABLE tax_invoices ADD COLUMN IF NOT EXISTS paid_branch text;
--> statement-breakpoint
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS fax text;
