import { pgTable, bigserial, bigint, text, numeric, date, timestamp, index, uniqueIndex, boolean, integer } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants';
import { vendors } from './procurement';
import { invoiceStatusEnum } from './enums';

export const arInvoices = pgTable('ar_invoices', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  invoiceNo: text('invoice_no').notNull().unique(), // INV-{order_no}
  invoiceDate: date('invoice_date'),
  dueDate: date('due_date'),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  orderNo: text('order_no'),
  amount: numeric('amount', { precision: 14, scale: 2 }),
  paidAmount: numeric('paid_amount', { precision: 14, scale: 2 }).default('0'),
  status: invoiceStatusEnum('status').default('Unpaid'),
  currency: text('currency').default('THB'),
  fxRate: numeric('fx_rate', { precision: 18, scale: 8 }).default('1'),
  remarks: text('remarks'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }),
});

export const arReceipts = pgTable('ar_receipts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  receiptNo: text('receipt_no').notNull().unique(), // RCP-
  receiptDate: date('receipt_date'),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  invoiceNo: text('invoice_no'),
  amount: numeric('amount', { precision: 14, scale: 2 }),
  method: text('method').default('Transfer'),
  refNo: text('ref_no'),
  remarks: text('remarks'),
  idempotencyKey: text('idempotency_key'), // client retry key — dedups a receipt per (tenant, key)
  // REV-21 (migration 0295) — the on-account (unapplied) portion of the receipt. A cash-application
  // receipt parks its remainder here (GL 2220 Unapplied Customer Receipts) until applied to invoices
  // later; legacy single-invoice receipts are fully applied at creation (0).
  unappliedAmount: numeric('unapplied_amount', { precision: 14, scale: 2 }).default('0'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }),
});

// AR cash application (REV-21, migration 0295) — one row per (receipt | credit-note) × invoice
// application, so ONE customer receipt can settle MANY invoices (partial allowed) and an Issued
// AR-linked credit note can be applied as a credit line in the same worksheet. A worksheet post is a
// BATCH (batch_no, APL-YYYYMMDD-NNN); each line carries its own application_no (`{batch}:L{n}`).
// An application batch at/over the approval threshold parks status='PendingApproval' (invoices +
// GL untouched; the cash sits on-account) until a DIFFERENT user approves it (SoD). A reversal is
// audited in place (reversed flag + reason + who/when) and returns the cash to on-account.
export const arReceiptApplications = pgTable('ar_receipt_applications', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  applicationNo: text('application_no').notNull().unique(), // APL-YYYYMMDD-NNN:L<line>
  batchNo: text('batch_no').notNull(),                      // one worksheet post = one batch (APL-YYYYMMDD-NNN)
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id), // the customer tenant (RLS)
  sourceType: text('source_type').notNull().default('receipt'), // receipt | credit_note
  receiptNo: text('receipt_no').notNull(),  // ar_receipts.receipt_no (or the CN doc_no when source_type='credit_note')
  invoiceNo: text('invoice_no').notNull(),  // ar_invoices.invoice_no the amount is applied to
  appliedAmount: numeric('applied_amount', { precision: 14, scale: 2 }).notNull(),
  status: text('status').notNull().default('applied'), // applied | PendingApproval | Rejected
  appliedBy: text('applied_by'),
  appliedAt: timestamp('applied_at', { withTimezone: true }).defaultNow(),
  approvedBy: text('approved_by'),                      // checker — must differ from appliedBy
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  rejectReason: text('reject_reason'),
  reversed: boolean('reversed').notNull().default(false),
  reversedBy: text('reversed_by'),
  reversedAt: timestamp('reversed_at', { withTimezone: true }),
  reverseReason: text('reverse_reason'),
}, (t) => ({
  byInvoice: index('idx_ar_apply_invoice').on(t.tenantId, t.invoiceNo),
  byReceipt: index('idx_ar_apply_receipt').on(t.tenantId, t.receiptNo),
  byBatch: index('idx_ar_apply_batch').on(t.tenantId, t.batchNo),
}));

// AR/AP netting & contra settlement (docs/41 FIN-8, REV-23, migration 0309) — a counterparty that is BOTH
// a customer (AR) and a vendor (AP) can have its open AR offset against its open AP with a single contra JE
// (Dr 2000 AP / Cr 1100 AR) that clears both sub-ledgers up to the netted amount, leaving the residual open.
//
// netting_agreements — the counterparty mapping + agreement/threshold. One row links a customer tenant (AR)
// to a vendor (AP) for our company (tenant_id = the netting company, RLS). netting_enabled gates whether
// netting is permitted; threshold (nullable) is a per-counterparty cap on the net amount of any one
// settlement. customer_tenant_id / vendor_id are FK columns (NOT the RLS tenant_id) so the generic RLS loop
// skips them.
export const nettingAgreements = pgTable('netting_agreements', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id), // RLS — our (netting) company
  customerTenantId: bigint('customer_tenant_id', { mode: 'number' }).references(() => tenants.id).notNull(), // the AR customer
  vendorId: bigint('vendor_id', { mode: 'number' }).references(() => vendors.id).notNull(),                  // the AP vendor
  vendorName: text('vendor_name'),          // denorm — AP bills match by name OR id
  counterpartyName: text('counterparty_name'),
  currency: text('currency').default('THB'),
  nettingEnabled: boolean('netting_enabled').notNull().default(true),
  threshold: numeric('threshold', { precision: 14, scale: 2 }), // null = no per-settlement cap
  notes: text('notes'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uxCounterparty: uniqueIndex('ux_netting_agreement').on(sql`coalesce(${t.tenantId}, 0)`, t.customerTenantId, t.vendorId),
  byCustomer: index('idx_netting_agreement_customer').on(t.tenantId, t.customerTenantId),
  byVendor: index('idx_netting_agreement_vendor').on(t.tenantId, t.vendorId),
}));

// netting_settlements — the maker-checker workflow header + netting-statement head. A settlement is PROPOSED
// (PendingApproval; no GL, no sub-ledger movement), then APPROVED by a DIFFERENT user (SoD) — only then does
// the contra JE post and both sub-ledgers clear. net_amount = min(open AR, open AP) [capped by threshold /
// requested amount].
export const nettingSettlements = pgTable('netting_settlements', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  settlementNo: text('settlement_no').notNull().unique(), // NET-YYYYMMDD-NNN
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id), // RLS — our company
  agreementId: bigint('agreement_id', { mode: 'number' }).references(() => nettingAgreements.id),
  customerTenantId: bigint('customer_tenant_id', { mode: 'number' }),
  vendorId: bigint('vendor_id', { mode: 'number' }),
  vendorName: text('vendor_name'),
  counterpartyName: text('counterparty_name'),
  currency: text('currency').default('THB'),
  arOpen: numeric('ar_open', { precision: 14, scale: 2 }),   // snapshot of open AR at settlement
  apOpen: numeric('ap_open', { precision: 14, scale: 2 }),   // snapshot of open AP at settlement
  netAmount: numeric('net_amount', { precision: 14, scale: 2 }).notNull(), // the offset (Dr 2000 / Cr 1100)
  threshold: numeric('threshold', { precision: 14, scale: 2 }), // snapshot of the agreement cap
  reason: text('reason').notNull(),
  status: text('status').notNull().default('PendingApproval'), // PendingApproval | Approved | Rejected
  proposedBy: text('proposed_by'),
  proposedAt: timestamp('proposed_at', { withTimezone: true }).defaultNow(),
  approvedBy: text('approved_by'),                             // checker — must differ from proposedBy
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  rejectReason: text('reject_reason'),
  jeEntryNo: text('je_entry_no'),                              // the contra JE posted at approval
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byStatus: index('idx_netting_settlement_status').on(t.tenantId, t.status),
}));

// netting_settlement_lines — the netting statement detail: which AR invoices + AP bills were offset and by
// how much. side='AR' (ar_invoices.invoice_no) | 'AP' (ap_transactions.txn_no).
export const nettingSettlementLines = pgTable('netting_settlement_lines', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  settlementId: bigint('settlement_id', { mode: 'number' }).notNull(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id), // RLS
  side: text('side').notNull(),          // AR | AP
  docNo: text('doc_no').notNull(),       // ar_invoices.invoice_no | ap_transactions.txn_no
  docOpen: numeric('doc_open', { precision: 14, scale: 2 }),      // open balance at settlement
  appliedAmount: numeric('applied_amount', { precision: 14, scale: 2 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  bySettlement: index('idx_netting_line_settlement').on(t.tenantId, t.settlementId),
}));

// AR collections / dunning log — one row per dunning action taken on an open invoice. The collections
// worklist derives current stage from the latest row; the history is the audit trail for the control.
export const arDunningLog = pgTable('ar_dunning_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  dunningNo: text('dunning_no').notNull().unique(), // DUN-
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id), // RLS — the customer tenant
  invoiceNo: text('invoice_no').notNull(),
  stage: text('stage').notNull(), // reminder | first_notice | second_notice | final_notice | legal
  channel: text('channel').default('email'), // email | phone | letter | sms
  daysOverdue: bigint('days_overdue', { mode: 'number' }), // snapshot at action time
  outstanding: numeric('outstanding', { precision: 14, scale: 2 }), // snapshot at action time
  promiseToPayDate: date('promise_to_pay_date'), // customer commitment, if any
  notes: text('notes'),
  messageStatus: text('message_status'),   // delivery outcome of the dunning notice: sent | failed | manual | not_sent
  messageRecipient: text('message_recipient'), // the email/phone/LINE id the notice was sent to
  actionedBy: text('actioned_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// Credit-control audit — every manual hold/release and credit-limit change on a customer, for the
// credit-manager workflow + change report. The current hold/limit live on the `tenants` master.
export const creditEvents = pgTable('credit_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id), // the customer
  eventType: text('event_type').notNull(), // hold | release | limit_change
  oldLimit: numeric('old_limit', { precision: 14, scale: 2 }),
  newLimit: numeric('new_limit', { precision: 14, scale: 2 }),
  reason: text('reason'),
  actionedBy: text('actioned_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  // Credit-limit maker-checker (audit G7, migration 0261): a limit_change is staged 'PendingApproval' and
  // applied only when a DIFFERENT user approves it. hold/release rows are instantaneous ⇒ default 'applied'.
  status: text('status').notNull().default('applied'), // applied | PendingApproval | Approved | Rejected
  reqNo: text('req_no'),                                // CUS-YYYYMMDD-NNN for a staged limit change
  approvedBy: text('approved_by'),                      // checker — must differ from actionedBy
  approvedAt: timestamp('approved_at', { withTimezone: true }),
});

// Petty cash / employee cash advances (EXP-07). An advance is ISSUED (cash out, Dr 1180 / Cr 1000) and
// later SETTLED against actual expense + returned cash (Dr expense + Dr 1000 / Cr 1180) so the advance
// clears. The outstanding balance is the asset 1180 control account.
export const employeeAdvances = pgTable('employee_advances', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  advanceNo: text('advance_no').notNull().unique(), // ADV-YYYYMMDD-NNN
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  payee: text('payee').notNull(),       // employee code / name receiving the float
  purpose: text('purpose'),
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(), // amount advanced
  status: text('status').notNull().default('open'), // open | settled
  projectId: bigint('project_id', { mode: 'number' }), // M4 (docs/32) — site-cash advance against a project (nullable)
  boqLineId: bigint('boq_line_id', { mode: 'number' }), // FU1 (docs/32) — consume this BoQ line's budget on settle
  expenseAccount: text('expense_account').default('5100'), // where settled spend lands
  settledExpense: numeric('settled_expense', { precision: 14, scale: 2 }).default('0'),
  returnedCash: numeric('returned_cash', { precision: 14, scale: 2 }).default('0'),
  issuedBy: text('issued_by'),
  issuedDate: date('issued_date'),
  settledBy: text('settled_by'),
  settledDate: date('settled_date'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byStatus: index('idx_adv_status').on(t.tenantId, t.status) }));

export const apTransactions = pgTable('ap_transactions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  txnNo: text('txn_no').notNull().unique(), // AP-
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id), // RLS — input VAT per shop (ภ.พ.30)
  vendorId: bigint('vendor_id', { mode: 'number' }).references(() => vendors.id),
  vendorName: text('vendor_name'), // เดิม Creditor_Name (denorm) — match by name OR id
  refDoc: text('ref_doc'),
  txnType: text('txn_type'),
  invoiceNo: text('invoice_no'),
  invoiceDate: date('invoice_date'),
  dueDate: date('due_date'),
  amount: numeric('amount', { precision: 14, scale: 2 }),
  vatAmount: numeric('vat_amount', { precision: 14, scale: 2 }), // input VAT (for รายงานภาษีซื้อ / ภ.พ.30)
  reverseCharge: boolean('reverse_charge').default(false), // ม.83/6 — imported-service bill self-assessed via ภ.พ.36 (VAT not on the vendor bill; payer remits + credits it)
  fxRate: numeric('fx_rate', { precision: 18, scale: 8 }).default('1'), // booked rate for FX revaluation
  paidAmount: numeric('paid_amount', { precision: 14, scale: 2 }).default('0'),
  currency: text('currency').default('THB'),
  status: invoiceStatusEnum('status').default('Unpaid'),
  remarks: text('remarks'),
  idempotencyKey: text('idempotency_key'), // client retry key — dedups a bill per (tenant, key)
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }),
});

// AP disbursement maker-checker (AP-PAY): a vendor payment is REQUESTED by a `creditors` holder (PendingApproval,
// no cash/GL effect) and APPROVED by a DIFFERENT user (approval authority) — only then does the bill's
// paid_amount move and the cash-disbursement GL post. Mirrors GL-05 (manual JE maker-checker). See 0115.
export const apPayments = pgTable('ap_payments', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  paymentNo: text('payment_no').notNull().unique(), // APP-YYYYMMDD-NNN
  txnNo: text('txn_no').notNull(),                   // → ap_transactions.txn_no
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  status: text('status').notNull().default('PendingApproval'), // PendingApproval | Approved | Rejected
  requestedBy: text('requested_by'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow(),
  approvedBy: text('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  rejectReason: text('reject_reason'),
  glRef: text('gl_ref'), // PAY-AP source_ref used at approval (idempotent GL post)
  idempotencyKey: text('idempotency_key'),
  // TAX-03 — withholding tax taken at payment time (ภ.ง.ด.3/53). Captured at request, computed + posted to
  // GL 2361 at approval. The vendor is paid net (amount − wht_amount); wht_amount is held to remit to the RD.
  whtIncomeType: text('wht_income_type'),                         // label, e.g. '3tre-service' (services 3%)
  whtRate: numeric('wht_rate', { precision: 6, scale: 4 }),       // 0.0300 = 3%
  whtAmount: numeric('wht_amount', { precision: 14, scale: 2 }),  // computed at approval on the pre-VAT base
}, (t) => ({
  byTxn: index('idx_ap_payments_txn').on(t.txnNo),
  byStatus: index('idx_ap_payments_status').on(t.tenantId, t.status),
  uxIdem: uniqueIndex('ux_ap_payments_idem').on(sql`coalesce(${t.tenantId}, 0)`, t.idempotencyKey).where(sql`${t.idempotencyKey} IS NOT NULL`),
}));

// AP payment run (FIN-2, EXP-13, migration 0297) — a BATCH disbursement proposal over the one-by-one
// AP-PAY maker-checker. A `creditors` holder PROPOSES a run (open approved AP selected by due-date cutoff;
// every line re-passes the 3-way-match gate, EXP-09), edits lines only while Draft, then submits for
// approval; a DIFFERENT user (approvals/gl_close) APPROVES it (SoD, mirrors EXP-06), and EXECUTION posts
// each line through the EXISTING requestApPayment→approveApPayment path (same GL + WHT postings as a
// manual payment; idempotent per line). The Thai bank bulk-transfer file is generated from the run and its
// SHA-256 is pinned on the run + status-logged for the audit trail. Bank-statement auto-match clears lines.
export const apPaymentRuns = pgTable('ap_payment_runs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  runNo: text('run_no').notNull().unique(), // APRUN-YYYYMMDD-NNN
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  status: text('status').notNull().default('Draft'), // Draft | PendingApproval | Approved | Executed | Rejected | Cancelled
  payDate: date('pay_date'),                 // intended value date (bank-file header)
  dueCutoff: date('due_cutoff'),             // selection cutoff — open AP due on/before this date
  bankAccountId: bigint('bank_account_id', { mode: 'number' }), // source house-bank (bank_accounts.id; file only — GL stays the manual path's)
  totalAmount: numeric('total_amount', { precision: 14, scale: 2 }).default('0'), // Σ gross line amounts
  totalWht: numeric('total_wht', { precision: 14, scale: 2 }).default('0'),       // Σ estimated WHT
  totalNet: numeric('total_net', { precision: 14, scale: 2 }).default('0'),       // Σ net cash out (bank-file total)
  totalDiscount: numeric('total_discount', { precision: 14, scale: 2 }).default('0'), // Σ early-payment discount taken (FIN-9, EXP-14) — reduces cash out, credited to discount income 4600
  lineCount: integer('line_count').default(0),
  createdBy: text('created_by'),             // proposer (maker)
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  approvedBy: text('approved_by'),           // checker — must differ from createdBy (SOD_VIOLATION)
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  rejectReason: text('reject_reason'),
  executedBy: text('executed_by'),
  executedAt: timestamp('executed_at', { withTimezone: true }),
  fileFormat: text('file_format'),           // generic | scb | kbank | bbl | iso20022 (last generated)
  fileHash: text('file_hash'),               // SHA-256 of the last generated bank file (audit evidence)
  fileGeneratedAt: timestamp('file_generated_at', { withTimezone: true }),
  remarks: text('remarks'),
}, (t) => ({ byStatus: index('idx_ap_payment_runs_status').on(t.tenantId, t.status) }));

export const apPaymentRunLines = pgTable('ap_payment_run_lines', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  runId: bigint('run_id', { mode: 'number' }).notNull(), // → ap_payment_runs.id
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  txnNo: text('txn_no').notNull(),          // → ap_transactions.txn_no
  vendorId: bigint('vendor_id', { mode: 'number' }),
  vendorName: text('vendor_name'),
  dueDate: date('due_date'),                // bill due date at propose time
  billAmount: numeric('bill_amount', { precision: 14, scale: 2 }), // bill gross at propose time
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(), // amount to pay (defaults to outstanding)
  // WHT summary (TAX-03 reuse) — resolved at propose/edit via the same tax_code resolution as a manual
  // payment; the AUTHORITATIVE amount is recomputed by approveApPayment at execution and copied back here.
  whtTaxCode: text('wht_tax_code'),
  whtIncomeType: text('wht_income_type'),
  whtRate: numeric('wht_rate', { precision: 6, scale: 4 }),
  whtAmount: numeric('wht_amount', { precision: 14, scale: 2 }),
  netAmount: numeric('net_amount', { precision: 14, scale: 2 }), // amount − wht − discount (cash out; bank-file detail)
  // Early-payment (dynamic) discount summary (FIN-9, EXP-14) — computed at propose/edit against an Active
  // ap_discount_terms policy for the vendor (days-early = due_date − run.pay_date) and honoured at execution.
  daysEarly: integer('days_early'),                                          // due_date − pay_date at propose (>0 = paying early)
  discountRate: numeric('discount_rate', { precision: 6, scale: 4 }),        // resolved sliding-scale rate applied
  discountAmount: numeric('discount_amount', { precision: 14, scale: 2 }),   // amount × rate — discount taken (Cr 4600), reduces cash
  discountAccount: text('discount_account'),                                 // resolved discount-income account (policy default 4600)
  discountPolicyId: bigint('discount_policy_id', { mode: 'number' }),        // → ap_discount_terms.id applied
  status: text('status').notNull().default('Selected'), // Selected | Paid | Failed
  paymentNo: text('payment_no'),            // APP- minted at execution (existing AP payment path)
  glRef: text('gl_ref'),                    // PAY-AP source_ref of the posted disbursement (clearing key)
  failReason: text('fail_reason'),
  cleared: boolean('cleared').default(false), // bank-statement auto-match confirmed the outflow
  clearedAt: timestamp('cleared_at', { withTimezone: true }),
}, (t) => ({
  byRun: index('idx_ap_payment_run_lines_run').on(t.tenantId, t.runId),
  byGlRef: index('idx_ap_payment_run_lines_glref').on(t.glRef),
}));

// Dynamic / early-payment discount policy (FIN-9, control EXP-14). A sliding-scale prompt-payment discount
// schedule offered on open approved AP bills — per-vendor (vendor_id set) or a global default (vendor_id NULL).
// Maker-checker CHANGE CONTROL: created Draft by 'creditors', activated by a DIFFERENT approvals/gl_close
// user (self-approval → SOD_VIOLATION); only an Active policy is applied by a payment run, and approving one
// supersedes the prior Active policy for the same vendor scope. The AP payment run computes the discount at
// propose/edit and captures it as income (Cr discount_account) at execution, reducing the cash disbursed.
export const apDiscountTerms = pgTable('ap_discount_terms', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  vendorId: bigint('vendor_id', { mode: 'number' }),          // → vendors.id; NULL = global default policy
  name: text('name').notNull(),
  discountPct: numeric('discount_pct', { precision: 6, scale: 4 }).notNull(), // nominal/max rate (e.g. 0.0200 = 2%)
  minDaysEarly: integer('min_days_early').notNull().default(1),   // must pay ≥ N days before due to earn ANY discount
  fullDiscountDays: integer('full_discount_days').notNull().default(20), // days-early at/above which the full rate applies
  prorate: boolean('prorate').notNull().default(true),           // true = rate scales with days_early/fullDiscountDays; false = flat rate once ≥ fullDiscountDays
  discountAccount: text('discount_account').notNull().default('4600'), // GL income account credited with the discount
  activeFrom: date('active_from'),                               // optional validity window (inclusive)
  activeTo: date('active_to'),
  status: text('status').notNull().default('Draft'),            // Draft | Active | Inactive | Rejected
  createdBy: text('created_by'),                                // maker (creditors)
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  approvedBy: text('approved_by'),                              // checker ≠ maker (approvals/gl_close)
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  rejectReason: text('reject_reason'),
}, (t) => ({
  byScope: index('idx_ap_discount_terms_scope').on(t.tenantId, t.status, t.vendorId),
}));
