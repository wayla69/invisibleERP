// WS2.3 — AR Allowance for Doubtful Accounts (ECL, REV-18). A periodic aging-driven provision: each open
// AR bucket carries a loss rate, the provision is Σ(outstanding × rate). It posts as the DELTA vs the prior
// posted allowance (Dr 5720 Bad-Debt Expense / Cr 1190 Allowance contra-asset; reversed if the allowance
// drops) under maker-checker (computer ≠ poster). One row per (tenant, as_of_date) — RLS via the 0166 loop.
import { pgTable, bigserial, bigint, text, numeric, boolean, date, timestamp, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const arAllowance = pgTable('ar_allowance', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  asOfDate: date('as_of_date').notNull(),
  method: text('method').notNull().default('aging'),          // 'aging' | 'percentage'
  totalAr: numeric('total_ar', { precision: 18, scale: 4 }).notNull().default('0'),
  allowance: numeric('allowance', { precision: 18, scale: 4 }).notNull().default('0'),
  buckets: jsonb('buckets'),                                   // [{bucket, outstanding, rate, provision}]
  posted: boolean('posted').notNull().default(false),
  postedEntryId: bigint('posted_entry_id', { mode: 'number' }),
  postedAmount: numeric('posted_amount', { precision: 18, scale: 4 }), // delta actually journalled (signed)
  computedBy: text('computed_by'),
  postedBy: text('posted_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  postedAt: timestamp('posted_at', { withTimezone: true }),
}, (t) => ({ uqAsOf: uniqueIndex('uq_ar_allowance_asof').on(t.tenantId, t.asOfDate) }));

export type ArAllowance = typeof arAllowance.$inferSelect;
