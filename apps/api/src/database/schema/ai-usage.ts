import { pgTable, bigserial, bigint, integer, date, timestamp, text, numeric, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Per-tenant daily AI token usage (ITGC-SEC-AI-01 — budget enforcement + cost attribution).
// Written via the AUTOCOMMIT PG_CLIENT so usage persists even when the request transaction rolls back.
export const aiTokenUsage = pgTable('ai_token_usage', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  usageDate: date('usage_date').notNull(), // business date in Asia/Bangkok (UTC+7)
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  // Tokens consumed beyond the plan's included daily cap (panel #3) — metered for billing visibility so an
  // over-limit tenant is charged, not silently served for free. Always finite (no unlimited tier).
  overageTokens: integer('overage_tokens').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// Monthly AI-overage billing ledger (Wave 1 — connect the meter to COLLECTION). One row per (tenant, month):
// the ai_overage_billing scheduled job appends a Stripe invoice item for the month's metered overage and
// records it here. The UNIQUE(tenant_id, billing_month) is the idempotency guard — a re-run never double-bills.
// Mirrors aiTokenUsage: operator/job-written, app-scoped reads (no RLS).
export const aiOverageBillingRuns = pgTable('ai_overage_billing_runs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  billingMonth: text('billing_month').notNull(), // 'YYYY-MM' (Asia/Bangkok business month)
  overageTokens: integer('overage_tokens').notNull().default(0),
  rateThbPer1k: numeric('rate_thb_per_1k', { precision: 10, scale: 2 }).notNull().default('0'),
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull().default('0'),
  currency: text('currency').notNull().default('THB'),
  stripeInvoiceItemId: text('stripe_invoice_item_id'), // NULL when no Stripe key (mock) or no customer
  status: text('status').notNull().default('pending'), // 'pending' | 'invoiced' (real) | 'recorded' (mock)
  processedBy: text('processed_by'),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uqTenantMonth: unique('ai_overage_billing_runs_tenant_month_uq').on(t.tenantId, t.billingMonth) }));
