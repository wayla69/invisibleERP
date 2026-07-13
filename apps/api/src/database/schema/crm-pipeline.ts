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
  // CRM-7 (CRM-07, migration 0365): a self-referential PARENT link so a company can be modelled as a
  // hierarchy (parent ⋈ subsidiaries). The set-parent endpoint rejects cycles (HIERARCHY_CYCLE).
  parentAccountId: bigint('parent_account_id', { mode: 'number' }),
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
  byParent: index('idx_crm_account_parent').on(t.tenantId, t.parentAccountId),
}));

// CRM-7 (CRM-07, migration 0365): the per-deal BUYING COMMITTEE — which contacts sit on an opportunity,
// each with a role + influence weight; at most one is_primary per deal. Tenant-scoped (RLS).
export const crmOpportunityContacts = pgTable('crm_opportunity_contacts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  opportunityId: bigint('opportunity_id', { mode: 'number' }).notNull().references(() => crmOpportunities.id),
  contactId: bigint('contact_id', { mode: 'number' }).notNull().references(() => crmContacts.id),
  role: text('role').notNull().default('user'),        // decision_maker | champion | influencer | evaluator | blocker | user
  influence: text('influence').notNull().default('medium'), // high | medium | low
  isPrimary: boolean('is_primary').notNull().default(false),
  notes: text('notes'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqOppContact: unique('uq_crm_opp_contact').on(t.tenantId, t.opportunityId, t.contactId),
  byOpp: index('idx_crm_opp_contact_opp').on(t.tenantId, t.opportunityId),
}));

// CRM-7 (CRM-07, migration 0365): a governed ACCOUNT PLAN (draft → active → closed) with an owner,
// objective, strategy, target revenue and target product categories (validated against item_categories).
// The whitespace read diffs the tenant's active item_categories against the account's active-plan targets.
export const crmAccountPlans = pgTable('crm_account_plans', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  planNo: text('plan_no').notNull(),                   // APL-YYYYMMDD-NNN
  accountId: bigint('account_id', { mode: 'number' }).notNull().references(() => crmAccounts.id),
  period: text('period'),                              // FY2026 / 2026-H1
  objective: text('objective'),
  strategy: text('strategy'),
  targetRevenue: numeric('target_revenue', { precision: 14, scale: 2 }).notNull().default('0'),
  targetCategories: jsonb('target_categories').notNull().default([]), // array of item_categories.code
  status: text('status').notNull().default('draft'),   // draft | active | closed
  owner: text('owner'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqNo: unique('uq_crm_account_plan_no').on(t.tenantId, t.planNo),
  byAccount: index('idx_crm_account_plan_account').on(t.tenantId, t.accountId),
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
  dealType: text('deal_type').notNull().default('new'), // CRM-15 (CRM-08, migration 0370): new | renewal | expansion
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

// CRM-15 (CRM-08, migration 0370): a persisted per-account HEALTH snapshot (mirrors project_health_snapshots)
// — a daily churn-watchlist score + band for trend. The live score is computed in CrmAccountHealthService;
// this table is the schedulable snapshot (upsert on (tenant_id, account_id, snapshot_date)). Tenant-scoped (RLS).
export const crmAccountHealthSnapshots = pgTable('crm_account_health_snapshots', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  accountId: bigint('account_id', { mode: 'number' }).notNull().references(() => crmAccounts.id),
  snapshotDate: date('snapshot_date').notNull(),
  score: integer('score').notNull().default(0),         // 0..100 (100 = healthiest)
  band: text('band').notNull().default('no_data'),      // healthy | watch | at_risk | no_data
  signals: jsonb('signals').notNull().default({}),      // per-factor breakdown snapshot
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqDay: unique('uq_crm_acct_health_day').on(t.tenantId, t.accountId, t.snapshotDate),
  byAccount: index('idx_crm_acct_health_account').on(t.tenantId, t.accountId),
}));

// CRM-12 (CRM-09, migration 0378): sales-forecasting depth over the REV-17 pipeline forecast.
// A rep→manager manual OVERRIDE: per (period, owner) a rep submits their own commit / best-case number
// (governed draft → submitted); the manager roll-up reconciles it against the system-weighted forecast.
export const crmForecastSubmissions = pgTable('crm_forecast_submissions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  period: text('period').notNull(),                    // 'YYYY-MM' (business month, Asia/Bangkok)
  owner: text('owner').notNull(),                      // the rep (crm_opportunities.owner)
  commitAmount: numeric('commit_amount', { precision: 14, scale: 2 }).notNull().default('0'),
  bestCaseAmount: numeric('best_case_amount', { precision: 14, scale: 2 }).notNull().default('0'),
  pipelineAmount: numeric('pipeline_amount', { precision: 14, scale: 2 }).notNull().default('0'),
  status: text('status').notNull().default('draft'),   // draft | submitted
  notes: text('notes'),
  submittedBy: text('submitted_by'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqPeriodOwner: unique('uq_crm_fc_sub_period_owner').on(t.tenantId, t.period, t.owner),
  byPeriod: index('idx_crm_fc_sub_period').on(t.tenantId, t.period),
}));

// CRM-12 (CRM-09, migration 0378): a dated, immutable period SNAPSHOT of the forecast + the period's actual
// won, so forecast-vs-actual ACCURACY and pipeline-coverage are tracked over time (schedulable via the BI
// report crm_forecast_snapshot; idempotent per period/day, mirrors crm_account_health_snapshots).
export const crmForecastSnapshots = pgTable('crm_forecast_snapshots', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  period: text('period').notNull(),                    // 'YYYY-MM'
  snapshotDate: date('snapshot_date').notNull(),
  forecastAmount: numeric('forecast_amount', { precision: 14, scale: 2 }).notNull().default('0'), // commit + best-case(w) + pipeline(w)
  commitAmount: numeric('commit_amount', { precision: 14, scale: 2 }).notNull().default('0'),
  bestCaseAmount: numeric('best_case_amount', { precision: 14, scale: 2 }).notNull().default('0'),
  pipelineAmount: numeric('pipeline_amount', { precision: 14, scale: 2 }).notNull().default('0'),
  weightedAmount: numeric('weighted_amount', { precision: 14, scale: 2 }).notNull().default('0'),
  openCount: integer('open_count').notNull().default(0),
  actualWonAmount: numeric('actual_won_amount', { precision: 14, scale: 2 }).notNull().default('0'),
  submittedTotal: numeric('submitted_total', { precision: 14, scale: 2 }).notNull().default('0'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqDay: unique('uq_crm_fc_snap_day').on(t.tenantId, t.period, t.snapshotDate),
  byPeriod: index('idx_crm_fc_snap_period').on(t.tenantId, t.period),
}));

// CRM-11 (CRM-10, migration 0385): persisted territory & quota master data over the REV-17 pipeline.
// A named territory with match criteria (regions/segments/categories) + a self-referential parent for a
// team roll-up hierarchy + a manager owner.
export const crmTerritories = pgTable('crm_territories', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  code: text('code').notNull(),                        // TERR-YYYYMMDD-NNN
  name: text('name').notNull(),
  description: text('description'),
  criteria: jsonb('criteria').notNull().default({}),   // { regions:[], segments:[], categories:[] }
  parentTerritoryId: bigint('parent_territory_id', { mode: 'number' }),  // self-FK, team roll-up
  manager: text('manager'),                            // territory manager (owner username)
  active: boolean('active').notNull().default(true),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqCode: unique('uq_crm_territory_code').on(t.tenantId, t.code),
  byParent: index('idx_crm_territory_parent').on(t.tenantId, t.parentTerritoryId),
}));

// The reps assigned to a territory (role rep | manager).
export const crmTerritoryMembers = pgTable('crm_territory_members', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  territoryId: bigint('territory_id', { mode: 'number' }).notNull().references(() => crmTerritories.id),
  owner: text('owner').notNull(),                      // the rep (crm_opportunities.owner)
  role: text('role').notNull().default('rep'),         // rep | manager
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqMember: unique('uq_crm_terr_member').on(t.tenantId, t.territoryId, t.owner),
  byTerritory: index('idx_crm_terr_member').on(t.tenantId, t.territoryId),
}));

// A per-period target for an owner OR a territory (scope + subject), so attainment is measured against an
// auditable quota rather than an ad-hoc number passed at request time.
export const crmQuotas = pgTable('crm_quotas', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  period: text('period').notNull(),                    // 'YYYY-MM'
  scope: text('scope').notNull(),                      // owner | territory
  subject: text('subject').notNull(),                  // owner username OR territory code
  targetAmount: numeric('target_amount', { precision: 14, scale: 2 }).notNull().default('0'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqQuota: unique('uq_crm_quota').on(t.tenantId, t.period, t.scope, t.subject),
  byPeriod: index('idx_crm_quota_period').on(t.tenantId, t.period),
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
  source: text('source'),                              // NULL = crm route; 'pipeline' = /api/pipeline route or 0294 data-migration; 'comms' = CRM-4 outbound send; 'inbound' = CRM-6 inbound reply
  threadToken: text('thread_token'),                   // CRM-6: deterministic reply-threading token embedded in CRM-4 outbound comms — crm-inbound matches replies back to THIS activity's entity
  legacyActivityId: bigint('legacy_activity_id', { mode: 'number' }), // provenance: old opportunity_activities.id (0294)
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byEntity: index('idx_crm_activity_entity').on(t.tenantId, t.entityType, t.entityNo),
  byThread: index('idx_crm_activity_thread').on(t.tenantId, t.threadToken), // CRM-6: resolve an inbound reply's thread token → its originating activity/entity
}));

// CRM-6 (docs/41 CRM-4 note — the deferred 2-way inbound side). Every inbound customer email that hits the
// per-tenant CRM address is journaled here — matched to a deal/lead (then also logged as a timeline activity)
// or parked as `unmatched` for the review queue. Doubles as the provider-redelivery dedupe anchor (message_id)
// and the authenticity/audit record (mirrors email-capture's message_log receipt). RLS-scoped (migration 0309).
export const crmInboundMessages = pgTable('crm_inbound_messages', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  messageId: text('message_id'),                        // provider Message-ID (dedupe key)
  fromAddr: text('from_addr').notNull(),                // normalised sender address
  subject: text('subject'),
  bodyPreview: text('body_preview'),                    // first ~2000 chars of the plain-text body
  threadToken: text('thread_token'),                    // token parsed from the reply (subject/body/headers), if any
  matchStatus: text('match_status').notNull().default('unmatched'), // matched | unmatched
  matchedBy: text('matched_by'),                        // thread_token | contact_email | lead_email | manual
  matchedEntityType: text('matched_entity_type'),       // opportunity | lead
  matchedEntityNo: text('matched_entity_no'),
  matchedContactId: bigint('matched_contact_id', { mode: 'number' }),
  activityId: bigint('activity_id', { mode: 'number' }), // the crm_activities row logged on a match
  reviewReason: text('review_reason'),                  // why it landed in the queue (e.g. no_match)
  resolved: boolean('resolved').notNull().default(false), // review-queue triage: true once linked or dismissed
  resolvedBy: text('resolved_by'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byQueue: index('idx_crm_inbound_queue').on(t.tenantId, t.matchStatus, t.resolved),
  byMsg: index('idx_crm_inbound_msg').on(t.tenantId, t.messageId),
}));

// CRM-4 automation — explainable, versioned rules-based lead score (grade A–D). ONE row per (tenant, lead),
// upserted by CrmPipelineService.scoreLead; `breakdown` carries the per-factor contributions so the grade is
// auditable (SOX posture, mirrors the customer_profiles churn/LTV formula). RLS-scoped (migration 0307).
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
// round_robin_owners: owners a new lead is auto-assigned across (rr_cursor = next index). RLS (migration 0307).
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
export type CrmInboundMessage = typeof crmInboundMessages.$inferSelect;
