// QMS-2 — CAPA (Corrective & Preventive Action) lifecycle with effectiveness sign-off (control QC-02).
// The system captured one-off quality dispositions (mfg-depth quality) and supplier claims (gr_claims) but
// had no MANAGED corrective-action loop: root-cause → action plan → verification → effectiveness sign-off →
// closure. This adds a first-class CAPA register whose CLOSURE requires an INDEPENDENT effectiveness
// verification (verified_by ≠ owner/created_by → 403 SOD_SELF_APPROVAL) and completion of every child action.
//
// Two tenant-scoped tables (canonical 0232-form tenant_isolation RLS + leading (tenant_id,…) index +
// app_user grants, migration 0332). A CAPA may LINK to an NCR (QMS-1) or a gr_claim via a generic, NULLABLE
// source_type/source_ref pair — deliberately NOT a FK to non_conformances, so this builds standalone (QMS-1
// is a sibling branch that may not exist yet). No GL posting.
import { pgTable, bigserial, bigint, text, date, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// action_type: 'corrective' | 'preventive' | 'both'
// status: 'open' → 'in_progress' → 'pending_verification' → 'closed' | 'cancelled'
// effectiveness_result: 'effective' | 'ineffective' | null (set at verification)
// source_type: 'ncr' | 'gr_claim' | 'complaint' | 'audit' | 'manual' | null (generic link, no FK)
export const capas = pgTable('capas', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  capaNo: text('capa_no').notNull(),
  sourceType: text('source_type'), // ncr | gr_claim | complaint | audit | manual
  sourceRef: text('source_ref'),   // free-text reference into the source system (NCR no / claim no / …)
  title: text('title').notNull(),
  problemStatement: text('problem_statement'),
  rootCause: text('root_cause'),
  actionType: text('action_type').notNull().default('corrective'), // corrective | preventive | both
  owner: text('owner').notNull(),
  targetDate: date('target_date'),
  status: text('status').notNull().default('open'),
  effectivenessResult: text('effectiveness_result'), // effective | ineffective | null
  verifiedBy: text('verified_by'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_capas_tenant').on(t.tenantId, t.status),
  uqNo: uniqueIndex('uq_capas_no').on(t.tenantId, t.capaNo),
  byTarget: index('idx_capas_target').on(t.tenantId, t.targetDate),
}));

// status: 'pending' | 'done'
export const capaActions = pgTable('capa_actions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  capaId: bigint('capa_id', { mode: 'number' }).notNull().references(() => capas.id),
  seq: bigint('seq', { mode: 'number' }).notNull().default(1),
  description: text('description').notNull(),
  owner: text('owner'),
  dueDate: date('due_date'),
  status: text('status').notNull().default('pending'), // pending | done
  completedBy: text('completed_by'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_capa_actions_tenant').on(t.tenantId, t.capaId),
  byCapa: index('idx_capa_actions_capa').on(t.capaId),
}));

export type Capa = typeof capas.$inferSelect;
export type CapaAction = typeof capaActions.$inferSelect;
