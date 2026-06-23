import { pgTable, bigserial, bigint, integer, text, jsonb, numeric, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Phase D4 — demand forecast runs. Persists one row per forecast: the algorithm chosen (auto-selected by
// lowest backtest WAPE unless the caller pins one), the accuracy metrics measured on a walk-forward
// hold-out window, and the horizon point forecasts (jsonb number[]). Tenant-scoped + RLS like every other
// tenant table — keeps an audit trail of forecast accuracy over time (SOX: model governance / backtest
// evidence). Lives off-ledger; no GL impact.
export const demandForecasts = pgTable('demand_forecasts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  itemId: text('item_id').notNull(),
  algorithm: text('algorithm').notNull(), // sma | ses | holt | seasonal_naive | croston
  selectedBy: text('selected_by'),        // lowest_wape | requested
  horizon: integer('horizon').notNull(),
  dataDays: integer('data_days'),
  wape: numeric('wape', { precision: 10, scale: 4 }),
  mase: numeric('mase', { precision: 10, scale: 4 }),
  rmse: numeric('rmse', { precision: 14, scale: 4 }),
  bias: numeric('bias', { precision: 14, scale: 4 }),
  forecast: jsonb('forecast').notNull(),  // number[] — horizon point forecasts
  createdBy: text('created_by'),
  createdAt: timestamp('created_at').defaultNow(),
});
