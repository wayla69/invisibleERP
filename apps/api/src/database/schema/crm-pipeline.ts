// CRM sales pipeline (REV-16): leads → opportunities (stage machine) → activities, on the customer-of-record.
// Tenant-scoped (RLS via migration 0150).
import { pgTable, bigserial, bigint, text, numeric, integer, date, boolean, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const crmLeads = pgTable('crm_leads', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  leadNo: text('lead_no').notNull(),                  // LEAD-YYYYMMDD-NNN
  name: text('name').notNull(),
  company: text('company'),
  email: text('email'),
  phone: text('phone'),
  source: text('source'),
  status: text('status').notNull().default('new'),    // new | qualified | converted | lost
  owner: text('owner'),
  customerNo: text('customer_no'),                     // set on conversion → customer_master
  lostReason: text('lost_reason'),
  notes: text('notes'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqNo: unique('uq_crm_lead_no').on(t.tenantId, t.leadNo) }));

export const crmOpportunities = pgTable('crm_opportunities', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  oppNo: text('opp_no').notNull(),                    // OPP-YYYYMMDD-NNN
  customerNo: text('customer_no'),                     // → customer_master
  name: text('name').notNull(),
  stage: text('stage').notNull().default('prospecting'), // prospecting | qualification | proposal | negotiation | won | lost
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull().default('0'),
  currency: text('currency').default('THB'),
  probability: integer('probability').notNull().default(10), // 0..100 (forecast weight)
  expectedCloseDate: date('expected_close_date'),
  owner: text('owner'),
  lostReason: text('lost_reason'),
  leadNo: text('lead_no'),                             // provenance
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
}, (t) => ({ uqNo: unique('uq_crm_opp_no').on(t.tenantId, t.oppNo), byStage: index('idx_crm_opp_stage').on(t.tenantId, t.stage), byCustomer: index('idx_crm_opp_customer').on(t.tenantId, t.customerNo) }));

export const crmActivities = pgTable('crm_activities', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  entityType: text('entity_type').notNull(),           // lead | opportunity
  entityNo: text('entity_no').notNull(),
  type: text('type').notNull(),                        // call | email | meeting | note | task
  subject: text('subject'),
  notes: text('notes'),
  dueDate: date('due_date'),
  done: boolean('done').notNull().default(false),
  owner: text('owner'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byEntity: index('idx_crm_activity_entity').on(t.tenantId, t.entityType, t.entityNo) }));

export type CrmLead = typeof crmLeads.$inferSelect;
export type CrmOpportunity = typeof crmOpportunities.$inferSelect;
