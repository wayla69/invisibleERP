// POS Tier 2 #8 — receipt reprint audit (ใบเสร็จ). A receipt is a THIRD document over a sale (not the
// tax invoice). The first issuance is the original; every later render is a COPY (สำเนา). No GL.
import { pgTable, bigserial, bigint, text, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const receiptPrints = pgTable('receipt_prints', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id), // RLS scope
  saleNo: text('sale_no').notNull(),                 // cust_pos_sales.sale_no
  channel: text('channel').notNull().default('print'), // print | email | sms
  isCopy: text('is_copy').notNull().default('false'),  // 'true' once the original already printed
  printedBy: text('printed_by'),
  printedAt: timestamp('printed_at', { withTimezone: true }).defaultNow(),
});

export type ReceiptPrint = typeof receiptPrints.$inferSelect;
