import { pgTable, bigserial, bigint, text, numeric, date, timestamp } from 'drizzle-orm/pg-core';
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
  actionedBy: text('actioned_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

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
  fxRate: numeric('fx_rate', { precision: 18, scale: 8 }).default('1'), // booked rate for FX revaluation
  paidAmount: numeric('paid_amount', { precision: 14, scale: 2 }).default('0'),
  currency: text('currency').default('THB'),
  status: invoiceStatusEnum('status').default('Unpaid'),
  remarks: text('remarks'),
  idempotencyKey: text('idempotency_key'), // client retry key — dedups a bill per (tenant, key)
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }),
});
