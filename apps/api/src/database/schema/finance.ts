import { pgTable, bigserial, bigint, text, numeric, date, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
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

// AP disbursement maker-checker (AP-PAY): a vendor payment is REQUESTED by a `creditors` holder (PendingApproval,
// no cash/GL effect) and APPROVED by a DIFFERENT user (approval authority) — only then does the bill's
// paid_amount move and the cash-disbursement GL post. Mirrors GL-05 (manual JE maker-checker). See 0111.
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
}, (t) => ({
  byTxn: index('idx_ap_payments_txn').on(t.txnNo),
  byStatus: index('idx_ap_payments_status').on(t.tenantId, t.status),
  uxIdem: uniqueIndex('ux_ap_payments_idem').on(sql`coalesce(${t.tenantId}, 0)`, t.idempotencyKey).where(sql`${t.idempotencyKey} IS NOT NULL`),
}));
