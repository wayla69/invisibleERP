// FX revaluation (ตีราคาอัตราแลกเปลี่ยน) — period-end rates vs THB base. tenant_id NULL = shared/HQ rate.
import { pgTable, bigserial, bigint, text, numeric, date, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const fxRates = pgTable('fx_rates', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id), // NULL = shared/HQ rate
  currency: text('currency').notNull(),          // ISO-4217 (foreign ccy); rate = THB per 1 foreign unit
  rateDate: date('rate_date').notNull(),
  rate: numeric('rate', { precision: 18, scale: 8 }).notNull(),
  source: text('source').default('manual'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byLookup: index('idx_fxrate_lookup').on(t.currency, t.rateDate) }));

export type FxRate = typeof fxRates.$inferSelect;
