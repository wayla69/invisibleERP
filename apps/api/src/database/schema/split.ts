import { pgTable, bigserial, bigint, text, integer, numeric, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// แยกบิล — groups the N check-sales produced when one dine-in order is split.
// Money/tax/GL live in cust_pos_sales (one row per check); this is the audit join.
export const posCheckSplits = pgTable('pos_check_splits', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  groupNo: text('group_no').notNull(),                 // SPLIT-YYYYMMDD-NNN (one per split operation)
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id), // RLS
  orderNo: text('order_no').notNull(),                 // source dine-in order (DIN-)
  checkSeq: integer('check_seq').notNull(),            // 1..N
  saleNo: text('sale_no').notNull(),                   // cust_pos_sales.sale_no for this check
  method: text('method').notNull(),                    // 'equal' | 'by_items'
  total: numeric('total', { precision: 14, scale: 2 }),
  status: text('status').default('Paid'),              // Paid | Pending
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
export type PosCheckSplit = typeof posCheckSplits.$inferSelect;
