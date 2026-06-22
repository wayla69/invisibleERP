// Fixed Assets (FI-AA): asset register + straight-line monthly depreciation + disposal.
// Every table carries tenant_id → the 0007 RLS loop scopes them. GL effects via LedgerService.postEntry.
import { pgTable, bigserial, bigint, text, numeric, date, integer, timestamp, pgEnum, unique, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const depMethodEnum = pgEnum('dep_method', ['straight_line']);
export const assetStatusEnum = pgEnum('asset_status', ['active', 'disposed', 'fully_depreciated']);

export const assetCategories = pgTable('asset_categories', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  defaultUsefulLifeYears: integer('default_useful_life_years').notNull().default(5),
  assetAccount: text('asset_account').notNull().default('1500'),
  accumDepAccount: text('accum_dep_account').notNull().default('1590'),
  depExpenseAccount: text('dep_expense_account').notNull().default('5200'),
  active: text('active').default('true'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqCatPerTenant: unique('uq_asset_cat').on(t.tenantId, t.code) }));

export const fixedAssets = pgTable('fixed_assets', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  assetNo: text('asset_no').notNull(),
  categoryId: bigint('category_id', { mode: 'number' }).references(() => assetCategories.id),
  name: text('name').notNull(),
  acquireDate: date('acquire_date').notNull(),
  acquireCost: numeric('acquire_cost', { precision: 18, scale: 4 }).notNull(),
  salvageValue: numeric('salvage_value', { precision: 18, scale: 4 }).notNull().default('0'),
  usefulLifeMonths: integer('useful_life_months').notNull(),
  depreciationMethod: depMethodEnum('depreciation_method').notNull().default('straight_line'),
  status: assetStatusEnum('status').notNull().default('active'),
  accumulatedDepreciation: numeric('accumulated_depreciation', { precision: 18, scale: 4 }).notNull().default('0'),
  netBookValue: numeric('net_book_value', { precision: 18, scale: 4 }).notNull(),
  lastDepreciatedPeriod: text('last_depreciated_period'),
  disposedDate: date('disposed_date'),
  disposalProceeds: numeric('disposal_proceeds', { precision: 18, scale: 4 }),
  disposalGainLoss: numeric('disposal_gain_loss', { precision: 18, scale: 4 }),
  acquireSource: text('acquire_source').notNull().default('cash'),
  // Physical-tracking fields (for QR asset tags + scan-to-locate). Accounting
  // status stays in `status`; these track where the asset physically is / who holds it.
  location: text('location'),
  department: text('department'),
  serialNo: text('serial_no'),
  assignedTo: text('assigned_to'),
  notes: text('notes'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqAssetPerTenant: unique('uq_fixed_asset_no').on(t.tenantId, t.assetNo), byStatus: index('idx_fa_status').on(t.status) }));

// Audit trail of physical asset moves (location/status changes via QR scan).
// tenant-scoped → covered by the RLS loop re-run in the migration.
export const assetMovements = pgTable('asset_movements', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  assetId: bigint('asset_id', { mode: 'number' }).references(() => fixedAssets.id),
  assetNo: text('asset_no'),
  moveDate: timestamp('move_date', { withTimezone: true }).defaultNow(),
  moveType: text('move_type'), // 'Scan Update' | 'Transfer' | 'Status Change'
  fromLocation: text('from_location'),
  toLocation: text('to_location'),
  fromStatus: text('from_status'),
  toStatus: text('to_status'),
  note: text('note'),
  byUser: text('by_user'),
});

export const depreciationRuns = pgTable('depreciation_runs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  runNo: text('run_no').notNull(),
  period: text('period').notNull(),
  postedAt: timestamp('posted_at', { withTimezone: true }).defaultNow(),
  totalDepreciation: numeric('total_depreciation', { precision: 18, scale: 4 }).notNull(),
  assetCount: integer('asset_count').notNull().default(0),
  journalNo: text('journal_no'),
  createdBy: text('created_by'),
}, (t) => ({ uqRunPeriodPerTenant: unique('uq_dep_run_period').on(t.tenantId, t.period) }));

export const depreciationLines = pgTable('depreciation_lines', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  runId: bigint('run_id', { mode: 'number' }).notNull().references(() => depreciationRuns.id),
  assetId: bigint('asset_id', { mode: 'number' }).notNull().references(() => fixedAssets.id),
  amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
  accumulatedAfter: numeric('accumulated_after', { precision: 18, scale: 4 }).notNull(),
  nbvAfter: numeric('nbv_after', { precision: 18, scale: 4 }).notNull(),
});

export type FixedAsset = typeof fixedAssets.$inferSelect;
export type AssetCategory = typeof assetCategories.$inferSelect;
export type DepreciationRun = typeof depreciationRuns.$inferSelect;
