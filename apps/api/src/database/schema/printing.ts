// Phase 4 — Receipts & printing. Receipts and kitchen tickets are rendered server-side (HTML + ESC/POS)
// and queued here; a CloudPRNT-capable printer or a small local agent pulls jobs (GET next → ack). No GL —
// a receipt is a non-fiscal document over a sale; the tax invoice (tax-docs) remains the fiscal record.
import { pgTable, bigserial, bigint, text, integer, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const printJobs = pgTable('print_jobs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id), // RLS scope
  branchId: bigint('branch_id', { mode: 'number' }),    // which outlet (NULL = untagged/HQ)
  jobType: text('job_type').notNull(),                  // receipt | kitchen
  station: text('station'),                             // kitchen station code (kitchen tickets)
  saleNo: text('sale_no'),                              // cust_pos_sales.sale_no (receipts)
  orderNo: text('order_no'),                            // dine_in_orders.order_no (kitchen tickets)
  format: text('format').notNull().default('escpos'),  // escpos | html
  payload: text('payload').notNull(),                   // rendered ticket bytes (ESC/POS) or HTML
  printerId: text('printer_id'),                        // target printer / agent id (NULL = any)
  status: text('status').notNull().default('queued'),  // queued | sent | printed | failed
  attempts: integer('attempts').notNull().default(0),
  error: text('error'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  printedAt: timestamp('printed_at', { withTimezone: true }),
});

export type PrintJob = typeof printJobs.$inferSelect;
