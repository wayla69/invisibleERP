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
}, (t) => ({
  byTenant: index('idx_sc_tenant').on(t.tenantId, t.status),
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
