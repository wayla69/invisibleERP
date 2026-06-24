import { pgTable, bigserial, bigint, text, numeric, date, timestamp, boolean, jsonb } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Daily KPI snapshot — materialized by BiService.refreshSnapshot()
export const biDailySnapshots = pgTable('bi_daily_snapshots', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  snapshotDate: date('snapshot_date').notNull(), // YYYY-MM-DD
  // Sales
  totalSales: numeric('total_sales', { precision: 18, scale: 4 }).default('0'),
  totalOrders: bigint('total_orders', { mode: 'number' }).default(0),
  avgOrderValue: numeric('avg_order_value', { precision: 18, scale: 4 }).default('0'),
  // Gross profit (GL-based)
  grossProfit: numeric('gross_profit', { precision: 18, scale: 4 }).default('0'),
  grossMarginPct: numeric('gross_margin_pct', { precision: 8, scale: 4 }).default('0'),
  // Working capital
  openAr: numeric('open_ar', { precision: 18, scale: 4 }).default('0'),
  openAp: numeric('open_ap', { precision: 18, scale: 4 }).default('0'),
  inventoryValue: numeric('inventory_value', { precision: 18, scale: 4 }).default('0'),
  // Pipeline
  pipelineValue: numeric('pipeline_value', { precision: 18, scale: 4 }).default('0'),
  weightedPipeline: numeric('weighted_pipeline', { precision: 18, scale: 4 }).default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// Scheduled report subscriptions
export const reportSubscriptions = pgTable('report_subscriptions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  name: text('name').notNull(),
  reportType: text('report_type').notNull(), // 'kpi_board' | 'sales_cube' | 'finance_trend' | 'pipeline_forecast' | 'inventory'
  filters: jsonb('filters').default({}),           // {period:'month', months:3, ...}
  frequency: text('frequency').notNull(),           // 'daily' | 'weekly' | 'monthly'
  recipients: jsonb('recipients').default([]),      // [{email:'...'},{webhook_url:'...'}]
  isActive: boolean('is_active').default(true),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// History of scheduled-report executions — written by BiService.runDue() / runSubscriptionNow()
export const reportRuns = pgTable('report_runs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  subscriptionId: bigint('subscription_id', { mode: 'number' }),
  name: text('name'),
  reportType: text('report_type'),
  frequency: text('frequency'),
  status: text('status').notNull().default('success'), // success | failed
  recipientsCount: bigint('recipients_count', { mode: 'number' }).notNull().default(0),
  summary: jsonb('summary').default({}),
  error: text('error'),
  ranAt: timestamp('ran_at', { withTimezone: true }).defaultNow(),
});
