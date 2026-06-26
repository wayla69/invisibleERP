import { pgTable, bigserial, bigint, text, numeric, timestamp, integer, boolean, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
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
  // WS3.3: maker-checker lifecycle. 'Draft' = newly computed (recomputable), 'Final' = computed+balanced,
  // 'Posted' = frozen as the official group result by a DIFFERENT user (SoD).
  status: text('status').notNull().default('Draft'),
  balanced: boolean('balanced'),               // CON-03: consolidated TB Σdr=Σcr after eliminations
  postedBy: text('posted_by'),                  // maker-checker checker (≠ runBy)
  postedAt: timestamp('posted_at', { withTimezone: true }),
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

// ── WS3.3: Eliminations (CON-03) + Segment reporting (CON-04) ───────────────────

// Configurable elimination rules that drive generateEliminations beyond the default 1150/2150 IC pair.
// rule_type: 'ic_balance' (default reciprocal IC receivable/payable) | 'ic_revenue' (IC revenue vs cost) |
//            'investment' (investment vs equity) | 'manual'.
export const consolEliminationRules = pgTable('consol_elimination_rules', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  groupId: bigint('group_id', { mode: 'number' }).notNull().references(() => consolidationGroups.id),
  name: text('name').notNull(),
  ruleType: text('rule_type').notNull().default('ic_balance'),
  matchAccountPattern: text('match_account_pattern'),
  debitAccount: text('debit_account'),
  creditAccount: text('credit_account'),
  active: boolean('active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byGroup: index('idx_cer_group').on(t.groupId),
}));

// Segment definitions map dimension values (branch/project/department/entity keys) into a reporting segment
// for IFRS-8 segment reporting (CON-04). member_keys is a JSONB array of dimension values, e.g. [1,3,7].
export const segmentDefinitions = pgTable('segment_definitions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  dimension: text('dimension').notNull().default('branch'), // 'branch' | 'project' | 'department' | 'entity'
  memberKeys: jsonb('member_keys'),
  active: boolean('active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_segdef_tenant').on(t.tenantId, t.dimension),
}));

export type ConsolEliminationRule = typeof consolEliminationRules.$inferSelect;
export type SegmentDefinition = typeof segmentDefinitions.$inferSelect;
