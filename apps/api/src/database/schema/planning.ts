// Phase 20 Batch 1A — EPM Planning & Budgeting (xP&A)
// Versioned budget plans with scenario analysis, driver-based projection, and 3-way variance.
// No GL effect — planning is off-ledger. tenant_id → RLS isolation.
import { pgTable, bigserial, bigint, text, numeric, timestamp, integer, index, boolean, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// ── Budget Versions — lifecycle: Working → Submitted → Approved → Baseline ──
export const budgetVersions = pgTable('budget_versions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  versionNo: text('version_no').notNull(),           // BV-{year}-{n:04d} — tenant-sequential
  name: text('name').notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  status: text('status').notNull().default('Working'), // Working | Submitted | Approved | Baseline
  notes: text('notes'),
  createdBy: text('created_by'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_budver_tenant').on(t.tenantId, t.fiscalYear),
  uqVersionNo: uniqueIndex('uq_budver_no').on(t.tenantId, t.versionNo),
}));

// ── Budget Scenarios — alternate projections inside one version (Base/Best/Worst/custom) ──
export const budgetScenarios = pgTable('budget_scenarios', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  versionId: bigint('version_id', { mode: 'number' }).notNull().references(() => budgetVersions.id),
  name: text('name').notNull(),          // Base | Best | Worst | custom
  description: text('description'),
  isDefault: boolean('is_default').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byVersion: index('idx_budscen_version').on(t.versionId),
}));

// ── Budget Drivers — rule-based projection (% of actual, rate × driver, or fixed override) ──
export const budgetDrivers = pgTable('budget_drivers', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  scenarioId: bigint('scenario_id', { mode: 'number' }).notNull().references(() => budgetScenarios.id),
  accountCode: text('account_code').notNull(),
  // percent: amount = previous-period GL actual × (1 + rateValue/100)
  // rate: amount = rateValue (fixed per period, across all specified periods)
  // absolute: amount = rateValue for a single period (one-off override)
  driverType: text('driver_type').notNull(),   // percent | rate | absolute
  rateValue: numeric('rate_value', { precision: 10, scale: 4 }).notNull(),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byScenario: index('idx_buddrv_scenario').on(t.scenarioId, t.accountCode),
}));

// ── Forecast Lines — per-account per-period plan amounts; updated manually or by driver run ──
export const forecastLines = pgTable('forecast_lines', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  scenarioId: bigint('scenario_id', { mode: 'number' }).notNull().references(() => budgetScenarios.id),
  accountCode: text('account_code').notNull(),
  costCenterCode: text('cost_center_code'),          // optional dimension
  period: text('period').notNull(),                  // 'YYYY-MM'
  amount: numeric('amount', { precision: 18, scale: 4 }).notNull().default('0'),
  source: text('source').notNull().default('Manual'), // Manual | Driver
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byScenarioPeriod: index('idx_fcst_scenario_period').on(t.scenarioId, t.period),
}));

export type BudgetVersion = typeof budgetVersions.$inferSelect;
export type BudgetScenario = typeof budgetScenarios.$inferSelect;
export type BudgetDriver = typeof budgetDrivers.$inferSelect;
export type ForecastLine = typeof forecastLines.$inferSelect;
