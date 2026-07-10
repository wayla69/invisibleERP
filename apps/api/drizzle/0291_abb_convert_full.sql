-- 0291: ABB → full tax-invoice conversion at the counter (POS-1, ม.86/4) — TAX-10.
-- tax_invoices already carries replaces_doc_no (ใบแทน / supersede chain, 0005) and the 'Replaced' status;
-- the conversion writes the linkage there (full invoice.replaces_doc_no = the ABB's doc_no, ABB → 'Replaced').
-- This partial unique index is the DB-level backstop for "ONE full invoice per ABB": two concurrent
-- conversions of the same slip cannot both insert (the service catches 23505 and returns the winner).
CREATE UNIQUE INDEX IF NOT EXISTS uq_tiv_converted_from
  ON tax_invoices (tenant_id, replaces_doc_no)
  WHERE replaces_doc_no IS NOT NULL AND type = 'full';
