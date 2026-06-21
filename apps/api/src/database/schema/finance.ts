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
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }),
});

export const apTransactions = pgTable('ap_transactions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  txnNo: text('txn_no').notNull().unique(), // AP-
  vendorId: bigint('vendor_id', { mode: 'number' }).references(() => vendors.id),
  vendorName: text('vendor_name'), // เดิม Creditor_Name (denorm) — match by name OR id
  refDoc: text('ref_doc'),
  txnType: text('txn_type'),
  invoiceNo: text('invoice_no'),
  invoiceDate: date('invoice_date'),
  dueDate: date('due_date'),
  amount: numeric('amount', { precision: 14, scale: 2 }),
  paidAmount: numeric('paid_amount', { precision: 14, scale: 2 }).default('0'),
  currency: text('currency').default('THB'),
  status: invoiceStatusEnum('status').default('Unpaid'),
  remarks: text('remarks'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }),
});
