// INV-1 — Landed-cost allocation (COST-01). A landed-cost voucher attaches freight / duty / insurance /
// broker charges to one or more posted goods receipts and apportions them into inventory unit cost
// (allocation basis: value / qty / weight). Posting capitalises the on-hand share into the perpetual
// sub-ledger (Dr 1200) and expenses the already-issued residual to costing variance (Dr 5500), crediting
// the landed-cost accrual liability (2010). Maker-checker: the poster must differ from the preparer.
// Both tables are tenant-scoped (tenant_id → RLS, leading (tenant_id, …) index).
import { pgTable, bigserial, bigint, text, numeric, timestamp, date, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Voucher header — the four charge buckets, the allocation basis, and the maker-checker lifecycle.
export const landedCostVouchers = pgTable('landed_cost_vouchers', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  voucherNo: text('voucher_no').notNull(),
  voucherDate: date('voucher_date').notNull(),
  basis: text('basis').notNull().default('value'), // value | qty | weight
  currency: text('currency').notNull().default('THB'),
  freight: numeric('freight', { precision: 18, scale: 2 }).notNull().default('0'),
  duty: numeric('duty', { precision: 18, scale: 2 }).notNull().default('0'),
  insurance: numeric('insurance', { precision: 18, scale: 2 }).notNull().default('0'),
  broker: numeric('broker', { precision: 18, scale: 2 }).notNull().default('0'),
  totalCharges: numeric('total_charges', { precision: 18, scale: 2 }).notNull().default('0'),
  accrualAccount: text('accrual_account').notNull().default('2010'),
  status: text('status').notNull().default('Draft'), // Draft | Posted | Cancelled
  memo: text('memo'),
  capitalizedTotal: numeric('capitalized_total', { precision: 18, scale: 2 }).notNull().default('0'),
  varianceTotal: numeric('variance_total', { precision: 18, scale: 2 }).notNull().default('0'),
  preparedBy: text('prepared_by'),
  preparedAt: timestamp('prepared_at', { withTimezone: true }).defaultNow(),
  postedBy: text('posted_by'),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  glEntryNo: text('gl_entry_no'),
}, (t) => ({
  byTenant: index('idx_lcv_tenant').on(t.tenantId, t.status),
  uqNo: uniqueIndex('uq_lcv_no').on(t.tenantId, t.voucherNo),
}));

// Allocation line — one target GR line per row. base_value / qty / weight are the apportionment bases;
// alloc/capitalized/variance are filled at post (or previewed by /allocate).
export const landedCostAllocations = pgTable('landed_cost_allocations', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  voucherNo: text('voucher_no').notNull(),
  grNo: text('gr_no'),
  itemId: text('item_id').notNull(),
  locationId: text('location_id').notNull().default('WH-MAIN'),
  qty: numeric('qty', { precision: 18, scale: 4 }).notNull().default('0'),
  weight: numeric('weight', { precision: 18, scale: 4 }).notNull().default('0'),
  baseValue: numeric('base_value', { precision: 18, scale: 2 }).notNull().default('0'),
  allocAmount: numeric('alloc_amount', { precision: 18, scale: 2 }).notNull().default('0'),
  capitalizedAmount: numeric('capitalized_amount', { precision: 18, scale: 2 }).notNull().default('0'),
  varianceAmount: numeric('variance_amount', { precision: 18, scale: 2 }).notNull().default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_lca_tenant').on(t.tenantId, t.voucherNo),
  byItem: index('idx_lca_item').on(t.tenantId, t.itemId),
}));

export type LandedCostVoucher = typeof landedCostVouchers.$inferSelect;
export type LandedCostAllocation = typeof landedCostAllocations.$inferSelect;
