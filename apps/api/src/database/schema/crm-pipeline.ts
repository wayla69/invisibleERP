// CRM sales pipeline (REV-17): leads → opportunities (stage machine) → activities, on the customer-of-record.
// Tenant-scoped (RLS via migration 0152). CRM-1 unification (migration 0294): crm_opportunities is the ONE
// opportunity spine — stages resolve from the tenant-configurable pipeline_stages (stage_id; the legacy
// lowercase `stage` string stays in sync for back-compat), accounts/contacts are first-class
// (crm_accounts/crm_contacts), every stage transition is audited in crm_stage_history, and the Batch 2A
// `opportunities` rows were data-migrated in (legacy_opportunity_id preserves provenance; the old table is
// read-legacy only — no write path remains).
import { pgTable, bigserial, bigint, text, numeric, integer, date, boolean, timestamp, jsonb, unique, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';
import { pipelineStages } from './pipeline';
import { posMembers } from './loyalty-members';

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

// Accounts (companies) — the CRM-side organisation record. Becomes the customer-of-record link once the
// account transacts (customer_no → customer_master). Duplicate-governed (DUPLICATE_SUSPECT on create;
// audited survivor-pattern merge soft-retires the duplicate: status='merged' + merged_into/by/at).
export const crmAccounts = pgTable('crm_accounts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  accountNo: text('account_no').notNull(),             // ACC-YYYYMMDD-NNN
  name: text('name').notNull(),
  taxId: text('tax_id'),
  industry: text('industry'),
  size: text('size'),                                  // e.g. micro | small | medium | large
  email: text('email'),
  phone: text('phone'),
  website: text('website'),
  ownerUserId: bigint('owner_user_id', { mode: 'number' }).references(() => users.id),
  customerNo: text('customer_no'),                     // → customer_master once transacting (nullable)
  status: text('status').notNull().default('active'),  // active | inactive | merged
  mergedInto: bigint('merged_into', { mode: 'number' }),
  mergedBy: text('merged_by'),
  mergedAt: timestamp('merged_at', { withTimezone: true }),
  notes: text('notes'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqNo: unique('uq_crm_account_no').on(t.tenantId, t.accountNo),
  byName: index('idx_crm_account_name').on(t.tenantId, t.name),
  byCustomer: index('idx_crm_account_customer').on(t.tenantId, t.customerNo),
}));

// Contacts (people) under an account. role tags the buying-committee seat; member_id optionally joins the
// loyalty identity (pos_members) for the B2C↔B2B 360.
export const crmContacts = pgTable('crm_contacts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  accountId: bigint('account_id', { mode: 'number' }).references(() => crmAccounts.id),
  name: text('name').notNull(),
  email: text('email'),
  phone: text('phone'),
  role: text('role').notNull().default('other'),       // decision_maker | billing | technical | other
  lineId: text('line_id'),                             // LINE / social handle (optional)
  memberId: bigint('member_id', { mode: 'number' }).references(() => posMembers.id), // loyalty join (optional)
  status: text('status').notNull().default('active'),  // active | inactive | merged
  notes: text('notes'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byAccount: index('idx_crm_contact_account').on(t.tenantId, t.accountId),
  byEmail: index('idx_crm_contact_email').on(t.tenantId, t.email),
}));

export const crmOpportunities = pgTable('crm_opportunities', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  oppNo: text('opp_no').notNull(),                    // OPP-YYYYMMDD-NNN (crm route) | OPP-NNNNN (legacy /api/pipeline route)
  customerNo: text('customer_no'),                     // → customer_master
  name: text('name').notNull(),
  stage: text('stage').notNull().default('prospecting'), // legacy string, kept in sync with stage_id (prospecting | qualification | proposal | negotiation | won | lost | <custom stage name>)
  stageId: bigint('stage_id', { mode: 'number' }).references(() => pipelineStages.id), // tenant-configurable stage (0294)
  status: text('status').notNull().default('Open'),    // Open | Won | Lost (derived from the stage machine)
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull().default('0'),
  currency: text('currency').default('THB'),
  probability: integer('probability').notNull().default(10), // 0..100 (forecast weight)
  expectedCloseDate: date('expected_close_date'),
  owner: text('owner'),                                // legacy free-text owner (kept for back-compat)
  ownerUserId: bigint('owner_user_id', { mode: 'number' }).references(() => users.id), // real user reference (0294)
  accountId: bigint('account_id', { mode: 'number' }).references(() => crmAccounts.id),
  primaryContactId: bigint('primary_contact_id', { mode: 'number' }).references(() => crmContacts.id),
  accountName: text('account_name'),                   // legacy free-text account (Batch 2A carry-over)
  lostReason: text('lost_reason'),
  winReason: text('win_reason'),
  notes: text('notes'),
  leadNo: text('lead_no'),                             // provenance
  legacyOpportunityId: bigint('legacy_opportunity_id', { mode: 'number' }), // provenance: old `opportunities.id` (0294 data-migration)
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
}, (t) => ({
  uqNo: unique('uq_crm_opp_no').on(t.tenantId, t.oppNo),
  byStage: index('idx_crm_opp_stage').on(t.tenantId, t.stage),
  byCustomer: index('idx_crm_opp_customer').on(t.tenantId, t.customerNo),
  byStatus: index('idx_crm_opp_status').on(t.tenantId, t.status),
  byAccount: index('idx_crm_opp_account').on(t.tenantId, t.accountId),
  byLegacy: index('idx_crm_opp_legacy').on(t.tenantId, t.legacyOpportunityId),
}));

// Append-only stage-transition audit (REV-17): who moved which opportunity from → to, when. Written on
// creation (from_stage NULL) and on every transition through either route (/api/crm/pipeline, /api/pipeline).
export const crmStageHistory = pgTable('crm_stage_history', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  opportunityId: bigint('opportunity_id', { mode: 'number' }).notNull().references(() => crmOpportunities.id),
  fromStage: text('from_stage'),
  toStage: text('to_stage').notNull(),
  changedBy: text('changed_by'),
  changedAt: timestamp('changed_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byOpp: index('idx_crm_stage_history_opp').on(t.tenantId, t.opportunityId) }));

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
  source: text('source'),                              // NULL = crm route; 'pipeline' = /api/pipeline route or 0294 data-migration
  legacyActivityId: bigint('legacy_activity_id', { mode: 'number' }), // provenance: old opportunity_activities.id (0294)
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byEntity: index('idx_crm_activity_entity').on(t.tenantId, t.entityType, t.entityNo) }));

// CRM-4 automation — explainable, versioned rules-based lead score (grade A–D). ONE row per (tenant, lead),
// upserted by CrmPipelineService.scoreLead; `breakdown` carries the per-factor contributions so the grade is
// auditable (SOX posture, mirrors the customer_profiles churn/LTV formula). RLS-scoped (migration 0301).
export const crmLeadScores = pgTable('crm_lead_scores', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  leadNo: text('lead_no').notNull(),
  score: integer('score').notNull().default(0),        // 0..100 weighted total
  grade: text('grade').notNull().default('D'),          // A | B | C | D
  version: text('version').notNull(),                   // formula version stamp (e.g. 'v1')
  breakdown: jsonb('breakdown'),                         // explainability: [{ factor, points, detail }]
  scoredAt: timestamp('scored_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqLead: unique('uq_crm_lead_score').on(t.tenantId, t.leadNo),
  byGrade: index('idx_crm_lead_score_grade').on(t.tenantId, t.grade),
}));

// CRM-4 follow-up discipline config — ONE row per tenant. sla_hours: a new lead must be touched within N
// hours (detective control REV-22). rotting_days: an open deal with no activity for N days is "rotting".
// round_robin_owners: owners a new lead is auto-assigned across (rr_cursor = next index). RLS (migration 0301).
export const crmFollowupSettings = pgTable('crm_followup_settings', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  slaHours: integer('sla_hours').notNull().default(24),
  rottingDays: integer('rotting_days').notNull().default(7),
  roundRobinOwners: jsonb('round_robin_owners').notNull().default('[]'), // string[] of usernames
  rrCursor: integer('rr_cursor').notNull().default(0),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqTenant: unique('uq_crm_followup_settings').on(t.tenantId) }));

export type CrmLead = typeof crmLeads.$inferSelect;
export type CrmOpportunity = typeof crmOpportunities.$inferSelect;
export type CrmAccount = typeof crmAccounts.$inferSelect;
export type CrmContact = typeof crmContacts.$inferSelect;
export type CrmLeadScore = typeof crmLeadScores.$inferSelect;
export type CrmFollowupSettings = typeof crmFollowupSettings.$inferSelect;
