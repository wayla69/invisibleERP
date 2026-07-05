// Thai Revenue-Department tax documents:
//  - tax_invoices / tax_invoice_lines : ใบกำกับภาษีเต็มรูป (ม.86/4) + อย่างย่อ (ม.86/6)
//  - wht_certificates / wht_cert_lines : หนังสือรับรองการหักภาษี ณ ที่จ่าย 50 ทวิ (ม.50 ทวิ)
// Seller/buyer/payer/payee are SNAPSHOT columns (frozen at issue) so an issued legal document is
// immutable even if the underlying tenant/vendor record later changes.
import { pgTable, bigserial, bigint, text, numeric, date, boolean, timestamp, integer, jsonb, pgEnum, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// credit_note = ใบลดหนี้ (ม.86/10) · debit_note = ใบเพิ่มหนี้ (ม.86/9) — sibling adjustment documents (0248)
export const taxInvoiceTypeEnum = pgEnum('tax_invoice_type', ['full', 'abbreviated', 'credit_note', 'debit_note']);
// PendingApproval = an issued credit/debit note awaiting the maker-checker GL approval (TAX-07); it is
// excluded from the ภ.พ.30 output-VAT report until approved (which flips it to Issued + posts the GL).
export const taxInvoiceStatusEnum = pgEnum('tax_invoice_status', ['Issued', 'Voided', 'Replaced', 'PendingApproval']);
export const taxDocSourceEnum = pgEnum('tax_doc_source', ['POS', 'AR']);

export const taxInvoices = pgTable('tax_invoices', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id), // RLS scope (seller)
  docNo: text('doc_no').notNull(),                        // TIV-/ATV-YYYYMM-NNNN — unique PER SELLER (below)
  bookNo: text('book_no'),                                 // เล่มที่ (optional)
  type: taxInvoiceTypeEnum('type').notNull(),              // full | abbreviated
  issueDate: date('issue_date').notNull(),                 // วันที่ออกใบกำกับภาษี
  sourceType: taxDocSourceEnum('source_type').notNull(),   // POS | AR
  sourceRef: text('source_ref').notNull(),                 // cust_pos_sales.sale_no | ar_invoices.invoice_no
  // seller snapshot (ม.86/4) — frozen at issue
  sellerName: text('seller_name').notNull(),
  sellerTaxId: text('seller_tax_id').notNull(),
  sellerBranchCode: text('seller_branch_code').notNull().default('00000'),
  sellerBranchLabel: text('seller_branch_label').notNull().default('สำนักงานใหญ่'),
  sellerAddress: text('seller_address').notNull(),
  // buyer block (REQUIRED for full; OPTIONAL for abbreviated) — snapshot
  buyerName: text('buyer_name'),
  buyerTaxId: text('buyer_tax_id'),
  buyerBranchCode: text('buyer_branch_code'),
  buyerAddress: text('buyer_address'),
  // amounts
  currency: text('currency').notNull().default('THB'),
  subtotal: numeric('subtotal', { precision: 14, scale: 2 }).notNull(),      // มูลค่าสินค้า/บริการ (ก่อน VAT)
  discount: numeric('discount', { precision: 14, scale: 2 }).default('0'),
  vatRate: numeric('vat_rate', { precision: 5, scale: 4 }).notNull().default('0.0700'),
  vatAmount: numeric('vat_amount', { precision: 14, scale: 2 }).notNull(),   // ภาษีมูลค่าเพิ่ม
  grandTotal: numeric('grand_total', { precision: 14, scale: 2 }).notNull(), // รวมทั้งสิ้น
  isVatInclusive: boolean('is_vat_inclusive').notNull().default(false),      // true = abbreviated slip display
  status: taxInvoiceStatusEnum('status').notNull().default('Issued'),
  replacesDocNo: text('replaces_doc_no'),                  // ใบแทน / reissue chain
  // Credit/Debit note (0248) — the referenced original ใบกำกับภาษี, the adjustment reason (ม.86/10(3)/(4)),
  // and the linked GL entry (Draft until the maker-checker approval posts it, TAX-07).
  originalDocNo: text('original_doc_no'),
  reason: text('reason'),
  glEntryNo: text('gl_entry_no'),
  voidReason: text('void_reason'),
  notes: text('notes'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqDocPerSeller: unique('uq_tiv_doc').on(t.tenantId, t.docNo) }));

export const taxInvoiceLines = pgTable('tax_invoice_lines', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  taxInvoiceId: bigint('tax_invoice_id', { mode: 'number' }).notNull().references(() => taxInvoices.id),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id), // RLS scope
  lineNo: numeric('line_no').notNull(),
  itemId: text('item_id'),
  description: text('description').notNull(),               // ชื่อ/ชนิด/ประเภทสินค้าหรือบริการ
  qty: numeric('qty', { precision: 14, scale: 3 }),
  uom: text('uom'),
  unitPrice: numeric('unit_price', { precision: 14, scale: 2 }),
  discount: numeric('discount', { precision: 14, scale: 2 }).default('0'),
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(), // line net (full) | VAT-incl (abbreviated)
});

// ── WHT 50 ทวิ (ม.50 ทวิ) — issued when the tenant PAYS a supplier with withholding ──
export const pndTypeEnum = pgEnum('pnd_type', ['PND1K', 'PND1KS', 'PND2', 'PND2K', 'PND3', 'PND3K', 'PND53']);
export const whtFormCopyEnum = pgEnum('wht_form_copy', ['copy1', 'copy2', 'copy3', 'copy4']); // ฉบับที่ 1–4
export const whtCertStatusEnum = pgEnum('wht_cert_status', ['Issued', 'Voided']);

export const whtCertificates = pgTable('wht_certificates', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id), // RLS scope (payer)
  docNo: text('doc_no').notNull(),               // WHT-YYYYMM-NNNN — unique PER PAYER (below)
  bookNo: text('book_no'),                       // เล่มที่ (optional)
  runNo: text('run_no'),                         // ลำดับที่ในแบบ (row no. inside the ภ.ง.ด.)
  pndType: pndTypeEnum('pnd_type').notNull(),    // derived ภ.ง.ด. form
  formCopy: whtFormCopyEnum('form_copy').notNull().default('copy1'),
  datePaid: date('date_paid').notNull(),         // วันเดือนปีที่จ่าย
  // payer snapshot = the tenant (ผู้มีหน้าที่หักภาษี ณ ที่จ่าย)
  payerName: text('payer_name').notNull(),
  payerTaxId: text('payer_tax_id').notNull(),
  payerBranchCode: text('payer_branch_code').notNull().default('00000'),
  payerAddress: text('payer_address').notNull(),
  // payee snapshot = supplier/contractor/employee (ผู้ถูกหักภาษี ณ ที่จ่าย)
  payeeName: text('payee_name').notNull(),
  payeeTaxId: text('payee_tax_id').notNull(),
  payeeBranchCode: text('payee_branch_code'),
  payeeAddress: text('payee_address'),
  payeeKind: text('payee_kind').notNull().default('company'), // 'person' | 'company' (drives pnd + rate)
  // ref to AP txn / payment
  apTxnNo: text('ap_txn_no'),
  paymentNo: text('payment_no'),
  // totals (Σ lines)
  totalPaid: numeric('total_paid', { precision: 14, scale: 2 }).notNull(),
  totalWht: numeric('total_wht', { precision: 14, scale: 2 }).notNull(),
  // เงื่อนไขการหักภาษี: 'withhold' หัก ณ ที่จ่าย | 'absorb_always' ออกให้ตลอดไป | 'absorb_once' ออกให้ครั้งเดียว | 'other'
  whtCondition: text('wht_condition').notNull().default('withhold'),
  whtConditionOther: text('wht_condition_other'),
  signerName: text('signer_name'),               // ผู้มีอำนาจลงนาม
  isReplacement: boolean('is_replacement').notNull().default(false), // ใบแทน
  status: whtCertStatusEnum('status').notNull().default('Issued'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqDocPerPayer: unique('uq_wht_doc').on(t.tenantId, t.docNo) }));

export const whtCertLines = pgTable('wht_cert_lines', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  whtCertId: bigint('wht_cert_id', { mode: 'number' }).notNull().references(() => whtCertificates.id),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id), // RLS scope
  incomeType: text('income_type').notNull(),     // '40(1)'..'40(8)' / '3tre' / 'other' — มาตรา 40 / 3 เตรส
  description: text('description'),               // รายละเอียดประเภทเงินได้ (required for 3tre/other)
  datePaid: date('date_paid'),
  amountPaid: numeric('amount_paid', { precision: 14, scale: 2 }).notNull(), // จำนวนเงินที่จ่าย (ฐานภาษี ไม่รวม VAT)
  rate: numeric('rate', { precision: 5, scale: 4 }).notNull(),               // อัตรา (0.03 = 3%)
  taxWithheld: numeric('tax_withheld', { precision: 14, scale: 2 }).notNull(),
});

// Step 7 — Thai tax filing register. Snapshots a computed PP30/PND return into a DRAFT→SUBMITTED→ACCEPTED
// record (one per tenant/type/period) with the figures as filed + the RD submission reference, for the
// auditable filing trail + the remittance calendar.
export const thaiTaxFilings = pgTable('thai_tax_filings', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  filingType: text('filing_type').notNull(),               // 'PP30' | 'PND3' | 'PND53'
  periodMonth: integer('period_month').notNull(),
  periodYear: integer('period_year').notNull(),
  status: text('status').notNull().default('DRAFT'),       // DRAFT | SUBMITTED | ACCEPTED
  outputVat: numeric('output_vat', { precision: 18, scale: 2 }).default('0'),
  inputVat: numeric('input_vat', { precision: 18, scale: 2 }).default('0'),
  netVat: numeric('net_vat', { precision: 18, scale: 2 }).default('0'),
  taxWithheld: numeric('tax_withheld', { precision: 18, scale: 2 }).default('0'),
  deadline: date('deadline'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  submissionRef: text('submission_ref'),
  snapshot: jsonb('snapshot'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uq: unique('uq_thai_tax_filing').on(t.tenantId, t.filingType, t.periodMonth, t.periodYear) }));

export type TaxInvoice = typeof taxInvoices.$inferSelect;
export type TaxInvoiceLine = typeof taxInvoiceLines.$inferSelect;
export type WhtCertificate = typeof whtCertificates.$inferSelect;
export type WhtCertLine = typeof whtCertLines.$inferSelect;
export type ThaiTaxFiling = typeof thaiTaxFilings.$inferSelect;
