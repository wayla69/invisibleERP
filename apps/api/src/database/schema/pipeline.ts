import { pgTable, bigserial, bigint, text, numeric, integer, boolean, date, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// ── Batch 2A: Sales Pipeline ───────────────────────────────────────────────────
// CRM-1 unification (migration 0293): pipeline_stages stays the LIVE tenant-configurable stage master
// (crm_opportunities.stage_id now points here). `opportunities` + `opportunity_activities` are READ-LEGACY
// ONLY — their rows were data-migrated into crm_opportunities / crm_activities (legacy_opportunity_id /
// legacy_activity_id preserve provenance) and no service writes them anymore. Do not add new write paths.

export const pipelineStages = pgTable('pipeline_stages', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  name: text('name').notNull(),
  sequence: integer('sequence').notNull().default(0),
  defaultProbability: integer('default_probability').notNull().default(0), // 0-100
  isWon: boolean('is_won').default(false),
  isLost: boolean('is_lost').default(false),
  isActive: boolean('is_active').default(true),
}, (t) => ({
  byTenant: index('idx_ps_stage_tenant').on(t.tenantId, t.sequence),
  uqName: uniqueIndex('uq_ps_stage_name').on(t.tenantId, t.name),
}));

export const opportunities = pgTable('opportunities', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  oppNo: text('opp_no').notNull().unique(),
  name: text('name').notNull(),
  accountName: text('account_name'),
  stageId: bigint('stage_id', { mode: 'number' }).references(() => pipelineStages.id),
  probability: integer('probability').notNull().default(0),
  expectedValue: numeric('expected_value', { precision: 18, scale: 4 }).notNull().default('0'),
  currency: text('currency').notNull().default('THB'),
  expectedClose: date('expected_close'),
  status: text('status').notNull().default('Open'), // Open | Won | Lost
  assignedTo: text('assigned_to'),
  winReason: text('win_reason'),
  lossReason: text('loss_reason'),
  notes: text('notes'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_opp_tenant').on(t.tenantId, t.status),
  byStage: index('idx_opp_stage').on(t.stageId),
}));

// activity_type: 'call' | 'email' | 'meeting' | 'task' | 'note'
export const opportunityActivities = pgTable('opportunity_activities', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  oppId: bigint('opp_id', { mode: 'number' }).notNull().references(() => opportunities.id),
  activityType: text('activity_type').notNull(),
  subject: text('subject').notNull(),
  notes: text('notes'),
  activityDate: date('activity_date'),
  completed: boolean('completed').default(false),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byOpp: index('idx_opp_act_opp').on(t.oppId),
}));

export type PipelineStage = typeof pipelineStages.$inferSelect;
export type Opportunity = typeof opportunities.$inferSelect;
