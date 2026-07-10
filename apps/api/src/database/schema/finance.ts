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
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }),
});

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

// AP payment run (FIN-2, EXP-13, migration 0295) — a BATCH disbursement proposal over the one-by-one
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
  netAmount: numeric('net_amount', { precision: 14, scale: 2 }), // amount − wht (cash out; bank-file detail)
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
