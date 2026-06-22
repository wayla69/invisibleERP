import { pgTable, bigserial, bigint, text, numeric, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// ── Batch 1C-A: Account Reconciliation ─────────────────────────────────────────

// One workspace per account + period + tenant; SoD: preparer ≠ certifier
export const reconPeriods = pgTable('recon_periods', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  accountCode: text('account_code').notNull(),
  period: text('period').notNull(),
  status: text('status').notNull().default('Open'), // Open | Reconciled | Certified
  glBalance: numeric('gl_balance', { precision: 18, scale: 4 }).notNull().default('0'),
  subledgerBalance: numeric('subledger_balance', { precision: 18, scale: 4 }).notNull().default('0'),
  preparedBy: text('prepared_by'),
  preparedAt: timestamp('prepared_at', { withTimezone: true }),
  certifiedBy: text('certified_by'),
  certifiedAt: timestamp('certified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_rp_tenant').on(t.tenantId, t.period),
  uqRecon: uniqueIndex('uq_rp_account_period').on(t.tenantId, t.accountCode, t.period),
}));

// source: 'GL' | 'Subledger' | 'Adjustment'
export const reconItems = pgTable('recon_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  reconPeriodId: bigint('recon_period_id', { mode: 'number' }).notNull().references(() => reconPeriods.id),
  source: text('source').notNull(),
  refDoc: text('ref_doc'),
  refLineId: bigint('ref_line_id', { mode: 'number' }),
  amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
  matchedItemId: bigint('matched_item_id', { mode: 'number' }),
  isMatched: boolean('is_matched').default(false),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byPeriod: index('idx_ri_period').on(t.reconPeriodId),
  byMatched: index('idx_ri_matched').on(t.reconPeriodId, t.isMatched),
}));

// ── Batch 1C-B: CO-PA Profitability Analysis ───────────────────────────────────

// segmentType: 'Brand' | 'Channel' | 'Product' | 'Region'
export const profitSegments = pgTable('profit_segments', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  segmentType: text('segment_type').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_ps_tenant').on(t.tenantId, t.segmentType),
  uqSegment: uniqueIndex('uq_ps_code').on(t.tenantId, t.segmentType, t.code),
}));

// driver: 'equal' | 'percent' | 'revenue'
export const allocationRules = pgTable('allocation_rules', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  name: text('name').notNull(),
  fromAccountCode: text('from_account_code').notNull(),
  toSegmentType: text('to_segment_type').notNull(),
  driver: text('driver').notNull().default('equal'),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_ar_tenant').on(t.tenantId),
}));

// Per-segment weight for driver='percent'
export const allocationWeights = pgTable('allocation_weights', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  ruleId: bigint('rule_id', { mode: 'number' }).notNull().references(() => allocationRules.id),
  segmentCode: text('segment_code').notNull(),
  weight: numeric('weight', { precision: 10, scale: 4 }).notNull().default('1.0000'),
}, (t) => ({
  byRule: index('idx_aw_rule').on(t.ruleId),
  uqWeight: uniqueIndex('uq_aw_rule_seg').on(t.ruleId, t.segmentCode),
}));

export const allocationRuns = pgTable('allocation_runs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  period: text('period').notNull(),
  status: text('status').notNull().default('Draft'),
  runBy: text('run_by'),
  runAt: timestamp('run_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_allrun_tenant').on(t.tenantId, t.period),
}));

export const allocationLines = pgTable('allocation_lines', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  runId: bigint('run_id', { mode: 'number' }).notNull().references(() => allocationRuns.id),
  ruleId: bigint('rule_id', { mode: 'number' }).references(() => allocationRules.id),
  segmentCode: text('segment_code').notNull(),
  segmentType: text('segment_type').notNull(),
  accountCode: text('account_code').notNull(),
  allocatedAmount: numeric('allocated_amount', { precision: 18, scale: 4 }).notNull().default('0'),
}, (t) => ({
  byRun: index('idx_alline_run').on(t.runId, t.segmentCode),
}));

export type ReconPeriod = typeof reconPeriods.$inferSelect;
export type ReconItem = typeof reconItems.$inferSelect;
export type ProfitSegment = typeof profitSegments.$inferSelect;
export type AllocationRun = typeof allocationRuns.$inferSelect;
