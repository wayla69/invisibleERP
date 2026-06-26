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
  // FX-04 maker-checker (0139): a manual rate is PendingApproval (unusable for revaluation/reporting) until a
  // DIFFERENT user approves it; external-feed rates auto-approve. DEFAULT 'Approved' keeps existing rows usable.
  status: text('status').notNull().default('Approved'), // Approved | PendingApproval | Rejected
  requestedBy: text('requested_by'),
  approvedBy: text('approved_by'),                       // checker — must differ from requested_by
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byLookup: index('idx_fxrate_lookup').on(t.currency, t.rateDate), byStatus: index('idx_fxrate_status').on(t.tenantId, t.status) }));

export type FxRate = typeof fxRates.$inferSelect;
