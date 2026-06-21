-- Phase 10: seller identity on tenants for Thai tax invoices (ม.86/4 + ประกาศอธิบดี ฉบับที่ 199).
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS legal_name text,
  ADD COLUMN IF NOT EXISTS branch_code text DEFAULT '00000',
  ADD COLUMN IF NOT EXISTS branch_label_th text DEFAULT 'สำนักงานใหญ่',
  ADD COLUMN IF NOT EXISTS vat_registered boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS vat_reg_date date,
  ADD COLUMN IF NOT EXISTS address_line1 text,
  ADD COLUMN IF NOT EXISTS address_line2 text,
  ADD COLUMN IF NOT EXISTS sub_district text,
  ADD COLUMN IF NOT EXISTS district text,
  ADD COLUMN IF NOT EXISTS province text,
  ADD COLUMN IF NOT EXISTS postal_code text;
