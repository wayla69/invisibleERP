import { pgTable, bigserial, bigint, text, numeric, timestamp, integer, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// ── Batch 1B: Financial Consolidation ──────────────────────────────────────────

export const consolidationGroups = pgTable('consolidation_groups', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  name: text('name').notNull(),
  baseCurrency: text('base_currency').notNull().default('THB'),
  fiscalYear: integer('fiscal_year').notNull(),
  notes: text('notes'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_cg_tenant').on(t.tenantId, t.fiscalYear),
}));

export const consolidationEntities = pgTable('consolidation_entities', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  groupId: bigint('group_id', { mode: 'number' }).notNull().references(() => consolidationGroups.id),
  entityTenantId: bigint('entity_tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  ownershipPct: numeric('ownership_pct', { precision: 7, scale: 4 }).notNull().default('100.0000'),
  entityCurrency: text('entity_currency').notNull().default('THB'),
  isActive: boolean('is_active').default(true),
}, (t) => ({
  byGroup: index('idx_ce_group').on(t.groupId),
  uqGroupEntity: uniqueIndex('uq_ce_group_entity').on(t.groupId, t.entityTenantId),
}));

export const consolidationRuns = pgTable('consolidation_runs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  groupId: bigint('group_id', { mode: 'number' }).notNull().references(() => consolidationGroups.id),
  period: text('period').notNull(),
  status: text('status').notNull().default('Draft'),
  runAt: timestamp('run_at', { withTimezone: true }).defaultNow(),
  runBy: text('run_by'),
}, (t) => ({
  byGroup: index('idx_cr_group').on(t.groupId, t.period),
}));

// lineType: 'Entity' | 'Elimination' | 'FX_CTA' | 'NCI'
export const consolidationRunLines = pgTable('consolidation_run_lines', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  runId: bigint('run_id', { mode: 'number' }).notNull().references(() => consolidationRuns.id),
  lineType: text('line_type').notNull(),
  entityTenantId: bigint('entity_tenant_id', { mode: 'number' }),
  accountCode: text('account_code').notNull(),
  amountThb: numeric('amount_thb', { precision: 18, scale: 4 }).notNull().default('0'),
  notes: text('notes'),
}, (t) => ({
  byRun: index('idx_crl_run').on(t.runId, t.accountCode),
}));

export type ConsolidationGroup = typeof consolidationGroups.$inferSelect;
export type ConsolidationEntity = typeof consolidationEntities.$inferSelect;
export type ConsolidationRun = typeof consolidationRuns.$inferSelect;
