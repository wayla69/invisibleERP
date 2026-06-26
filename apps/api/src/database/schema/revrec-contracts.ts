// WS3.4 — Revenue recognition under TFRS 15 / IFRS 15 (REV-19). The "real ERP" deferred-revenue engine:
// a contract with multiple performance obligations, transaction price allocated by standalone selling
// price (SSP), revenue recognized over time (straight-line) or at a point in time, releasing a contract
// liability (2410 Deferred Revenue) to revenue (4300) and providing a refund liability (2420) for returns.
// Distinct from the legacy straight-line DEFREV schedule (rev_rec_schedules in ./revenue.ts). tenant_id → RLS.
import { pgTable, bigserial, bigint, text, numeric, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const revContracts = pgTable('rev_contracts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  customerId: bigint('customer_id', { mode: 'number' }),
  contractNo: text('contract_no').notNull(),
  contractDate: text('contract_date').notNull(),           // 'YYYY-MM-DD'
  currency: text('currency').default('THB'),
  totalPrice: numeric('total_price', { precision: 18, scale: 4 }).notNull(),
  status: text('status').notNull().default('Draft'),       // Draft | Active | Completed | Cancelled
  description: text('description'),
  invoiceEntryId: bigint('invoice_entry_id', { mode: 'number' }),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqNo: uniqueIndex('uq_rev_contract_no').on(t.tenantId, t.contractNo),
  byTenant: index('idx_rev_contract_tenant').on(t.tenantId),
}));

export const performanceObligations = pgTable('performance_obligations', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  contractId: bigint('contract_id', { mode: 'number' }).notNull().references(() => revContracts.id),
  name: text('name').notNull(),
  ssp: numeric('ssp', { precision: 18, scale: 4 }).notNull(),
  allocatedPrice: numeric('allocated_price', { precision: 18, scale: 4 }).notNull().default('0'),
  method: text('method').notNull().default('point_in_time'), // point_in_time | over_time
  startDate: text('start_date'),                              // 'YYYY-MM-DD'
  endDate: text('end_date'),                                  // 'YYYY-MM-DD'
  satisfiedPct: numeric('satisfied_pct', { precision: 9, scale: 4 }).notNull().default('0'),
  status: text('status').notNull().default('Pending'),       // Pending | InProgress | Satisfied
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byContract: index('idx_po_contract').on(t.contractId) }));

export const revrecSchedules = pgTable('revrec_schedules', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  contractId: bigint('contract_id', { mode: 'number' }).notNull().references(() => revContracts.id),
  obligationId: bigint('obligation_id', { mode: 'number' }).notNull().references(() => performanceObligations.id),
  period: text('period').notNull(),                          // 'YYYY-MM'
  plannedAmount: numeric('planned_amount', { precision: 18, scale: 4 }).notNull(),
  recognizedAmount: numeric('recognized_amount', { precision: 18, scale: 4 }).notNull().default('0'),
  recognized: boolean('recognized').notNull().default(false),
  recognizedEntryId: bigint('recognized_entry_id', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byContract: index('idx_revrec_sched_contract').on(t.contractId),
  byPeriod: index('idx_revrec_sched_period').on(t.tenantId, t.period, t.recognized),
}));

export const refundLiability = pgTable('refund_liability', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  contractId: bigint('contract_id', { mode: 'number' }).notNull().references(() => revContracts.id),
  asOfDate: text('as_of_date').notNull(),                    // 'YYYY-MM-DD'
  expectedRefundRate: numeric('expected_refund_rate', { precision: 9, scale: 4 }).notNull(),
  expectedRefundAmount: numeric('expected_refund_amount', { precision: 18, scale: 4 }).notNull(),
  posted: boolean('posted').notNull().default(false),
  postedEntryId: bigint('posted_entry_id', { mode: 'number' }),
  postedAmount: numeric('posted_amount', { precision: 18, scale: 4 }),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byContract: index('idx_refund_liab_contract').on(t.contractId) }));

export type RevContract = typeof revContracts.$inferSelect;
export type PerformanceObligation = typeof performanceObligations.$inferSelect;
export type RevrecSchedule = typeof revrecSchedules.$inferSelect;
export type RefundLiability = typeof refundLiability.$inferSelect;
