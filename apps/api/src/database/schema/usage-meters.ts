import { pgTable, bigserial, bigint, integer, text, numeric, timestamp, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Generic per-event usage meter (1.5 — extend metering beyond AI tokens to billable business events:
// e-Tax documents submitted, POS transactions). One row PER billable event, deduped by a natural key
// (doc_no / sale_no) so re-processing the same event never double-counts. Written via the AUTOCOMMIT
// PG_CLIENT (like ai_token_usage) so a metered event survives a request-transaction rollback, and it is
// best-effort — a metering failure never blocks the underlying sale/submission.
// The UNIQUE (tenant_id, meter, event_key) both dedups AND gives the tenant-leading index the R1-1 guard
// requires. Operator/job-scoped reads (the billing job is an HQ/exec cross-tenant operator) — no RLS, same
// as ai_token_usage / ai_overage_billing_runs.
export const usageEvents = pgTable('usage_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  meter: text('meter').notNull(),         // 'etax_docs' | 'pos_txns'
  eventKey: text('event_key').notNull(),  // natural idempotency key (TIV/ATV doc_no, SALE-… sale_no)
  period: text('period').notNull(),       // 'YYYY-MM' (Asia/Bangkok business month)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uqTenantMeterKey: unique('usage_events_tenant_meter_key_uq').on(t.tenantId, t.meter, t.eventKey) }));

// Monthly usage-overage billing ledger — the generic counterpart of ai_overage_billing_runs, keyed per
// (tenant, meter, month). The usage_overage_billing scheduled job counts the month's metered events beyond
// the plan's included quota and appends ONE Stripe invoice item per (tenant, meter, month); this row is its
// idempotency guard + audit trail. Mirrors ai_overage_billing_runs (operator/job-written, app-scoped reads).
export const usageOverageBillingRuns = pgTable('usage_overage_billing_runs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  meter: text('meter').notNull(),
  billingMonth: text('billing_month').notNull(), // 'YYYY-MM' (Asia/Bangkok business month)
  overageUnits: integer('overage_units').notNull().default(0),
  rateThbPerUnit: numeric('rate_thb_per_unit', { precision: 10, scale: 2 }).notNull().default('0'),
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull().default('0'),
  currency: text('currency').notNull().default('THB'),
  stripeInvoiceItemId: text('stripe_invoice_item_id'), // NULL when no Stripe key (mock) or no customer
  status: text('status').notNull().default('pending'), // 'pending' | 'invoiced' (real) | 'recorded' (mock)
  processedBy: text('processed_by'),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uqTenantMeterMonth: unique('usage_overage_billing_runs_tenant_meter_month_uq').on(t.tenantId, t.meter, t.billingMonth) }));
