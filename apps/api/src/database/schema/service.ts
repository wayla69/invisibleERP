import { pgTable, bigserial, bigint, text, numeric, integer, boolean, date, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// ── Batch 2C: Service Contracts + Subscriptions ───────────────────────────────

// sla_tier: 'Bronze' | 'Silver' | 'Gold' | 'Platinum'
// Tier SLA hours — response / resolution:
//   Bronze: 8h / 72h   Silver: 4h / 24h   Gold: 2h / 8h   Platinum: 1h / 4h
export const serviceContracts = pgTable('service_contracts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  contractNo: text('contract_no').notNull().unique(),
  customerName: text('customer_name').notNull(),
  slaTier: text('sla_tier').notNull().default('Silver'),
  responseHours: integer('response_hours').notNull().default(4),
  resolutionHours: integer('resolution_hours').notNull().default(24),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  status: text('status').notNull().default('Active'), // Active | Expired | Terminated
  monthlyValue: numeric('monthly_value', { precision: 18, scale: 4 }).notNull().default('0'),
  currency: text('currency').notNull().default('THB'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  // ── SVC-3 (migration 0330) — renewal & expiry lifecycle. Additive; NOT touched by the SLA/subscription
  //    paths. renewal_status: none | pending | renewed | declined. renewed_to_contract_id → successor row. ──
  renewalStatus: text('renewal_status').notNull().default('none'),
  autoRenew: boolean('auto_renew').notNull().default(false),
  renewalUpliftPct: numeric('renewal_uplift_pct', { precision: 6, scale: 3 }).notNull().default('0'),
  renewedToContractId: bigint('renewed_to_contract_id', { mode: 'number' }),
}, (t) => ({
  byTenant: index('idx_sc_tenant').on(t.tenantId, t.status),
}));

// ── SVC-3 (migration 0330): Service-contract renewal workflow (SVC-02 maker-checker + expiry worklist) ──────
// A proposed renewal of a contract. status: pending → approved | rejected. A renewal whose uplift_pct exceeds
// the tenant threshold (contract_renewal_settings.max_auto_uplift_pct), or an auto-renew that would raise
// price, is parked `pending` and the successor service_contracts row is created ONLY when a DIFFERENT user
// approves (approved_by ≠ requested_by → SOD_SELF_APPROVAL). Within-threshold renewals auto-approve.
export const contractRenewals = pgTable('contract_renewals', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  renewalNo: text('renewal_no').notNull().unique(),
  contractId: bigint('contract_id', { mode: 'number' }).notNull().references(() => serviceContracts.id),
  proposedStart: date('proposed_start').notNull(),
  proposedEnd: date('proposed_end').notNull(),
  baseValue: numeric('base_value', { precision: 18, scale: 4 }).notNull().default('0'),
  upliftPct: numeric('uplift_pct', { precision: 6, scale: 3 }).notNull().default('0'),
  newValue: numeric('new_value', { precision: 18, scale: 4 }).notNull().default('0'),
  autoRenew: boolean('auto_renew').notNull().default(false),
  status: text('status').notNull().default('pending'), // pending | approved | rejected
  reason: text('reason'),
  requestedBy: text('requested_by'),
  approvedBy: text('approved_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
}, (t) => ({
  byTenant: index('idx_contract_renewals_tenant').on(t.tenantId, t.status),
  byContract: index('idx_contract_renewals_contract').on(t.contractId),
}));

// Per-tenant renewal-uplift threshold (SVC-02). Change-gated (exec). Auto-approval ceiling for a renewal's
// price uplift — a renewal above this % (or an auto-renew that raises price at all) routes to maker-checker.
export const contractRenewalSettings = pgTable('contract_renewal_settings', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  maxAutoUpliftPct: numeric('max_auto_uplift_pct', { precision: 6, scale: 3 }).notNull().default('5'),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: uniqueIndex('idx_contract_renewal_settings_tenant').on(t.tenantId),
}));

// priority: 'P1' | 'P2' | 'P3' | 'P4'
// status: 'Open' | 'InProgress' | 'Resolved' | 'Closed'
export const slaEvents = pgTable('sla_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  contractId: bigint('contract_id', { mode: 'number' }).notNull().references(() => serviceContracts.id),
  eventNo: text('event_no').notNull().unique(),
  title: text('title').notNull(),
  priority: text('priority').notNull().default('P3'),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  responseDueAt: timestamp('response_due_at', { withTimezone: true }),
  respondedAt: timestamp('responded_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolutionDueAt: timestamp('resolution_due_at', { withTimezone: true }),
  responseBreached: boolean('response_breached').default(false),
  resolutionBreached: boolean('resolution_breached').default(false),
  status: text('status').notNull().default('Open'),
  notes: text('notes'),
  createdBy: text('created_by'),
}, (t) => ({
  byContract: index('idx_sla_contract').on(t.contractId, t.status),
}));

// billing_cycle: 'monthly' | 'quarterly' | 'annual'
// status: 'Active' | 'Paused' | 'Cancelled'
export const serviceSubscriptions = pgTable('service_subscriptions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  subNo: text('sub_no').notNull().unique(),
  customerName: text('customer_name').notNull(),
  productCode: text('product_code').notNull(),
  description: text('description'),
  billingCycle: text('billing_cycle').notNull().default('monthly'),
  unitPrice: numeric('unit_price', { precision: 18, scale: 4 }).notNull(),
  qty: integer('qty').notNull().default(1),
  currency: text('currency').notNull().default('THB'),
  startDate: date('start_date').notNull(),
  nextBillingDate: date('next_billing_date').notNull(),
  status: text('status').notNull().default('Active'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_svc_sub_tenant').on(t.tenantId, t.status),
  byNextBilling: index('idx_svc_sub_billing').on(t.nextBillingDate),
}));

// status: 'Draft' | 'Sent' | 'Paid'
export const serviceSubscriptionInvoices = pgTable('service_subscription_invoices', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  subscriptionId: bigint('subscription_id', { mode: 'number' }).notNull().references(() => serviceSubscriptions.id),
  invoiceNo: text('invoice_no').notNull().unique(),
  billingPeriod: text('billing_period').notNull(),
  amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
  currency: text('currency').notNull().default('THB'),
  status: text('status').notNull().default('Draft'),
  generatedAt: timestamp('generated_at', { withTimezone: true }).defaultNow(),
  dueDate: date('due_date'),
}, (t) => ({
  bySub: index('idx_svc_si_sub').on(t.subscriptionId),
}));

export type ServiceContract = typeof serviceContracts.$inferSelect;
export type ServiceSubscription = typeof serviceSubscriptions.$inferSelect;
export type ContractRenewal = typeof contractRenewals.$inferSelect;
export type ContractRenewalSetting = typeof contractRenewalSettings.$inferSelect;
