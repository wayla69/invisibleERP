// W3 (docs/27) — post-purchase NPS micro-survey. One row per sent survey; the public answer route is keyed
// by the single-use `token` (never a member id — no PII in the URL, per the CWE-598 lesson). A detractor
// (score ≤ 6) fires `loyalty.nps_detractor` into the automation catalog for service recovery.
import { pgTable, bigserial, bigint, text, integer, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { posMembers } from './loyalty-members';

export const npsResponses = pgTable('nps_responses', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  memberId: bigint('member_id', { mode: 'number' }).notNull().references(() => posMembers.id),
  token: text('token').notNull(),
  saleRef: text('sale_ref'),
  channel: text('channel'),
  score: integer('score'),                 // 0–10; null until answered
  comment: text('comment'),
  sentAt: timestamp('sent_at', { withTimezone: true }).defaultNow(),
  respondedAt: timestamp('responded_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdBy: text('created_by'),
}, (t) => ({
  uqToken: uniqueIndex('nps_responses_token').on(t.token),
  // one survey per member × sale (idempotent post-purchase trigger); NULL sale_refs stay distinct
  uqSale: uniqueIndex('nps_responses_member_sale').on(t.memberId, t.saleRef),
  idxTenant: index('nps_responses_tenant').on(t.tenantId),
}));

// V2 (docs/29, control LYL-20) — service-recovery cases: every detractor answer opens exactly ONE owned,
// SLA-timed case (unique source_ref). Status Open → Contacted → Resolved; actor-stamped transitions.
export const recoveryCases = pgTable('recovery_cases', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  memberId: bigint('member_id', { mode: 'number' }).notNull().references(() => posMembers.id),
  source: text('source').notNull().default('nps'),
  sourceRef: text('source_ref').notNull(),
  score: integer('score'),
  comment: text('comment'),
  status: text('status').notNull().default('Open'),
  responseDueAt: timestamp('response_due_at', { withTimezone: true }),
  contactedAt: timestamp('contacted_at', { withTimezone: true }),
  contactedBy: text('contacted_by'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: text('resolved_by'),
  resolutionNote: text('resolution_note'),
  assignee: text('assignee'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqSource: uniqueIndex('recovery_cases_source').on(t.source, t.sourceRef),
  idxTenant: index('recovery_cases_tenant').on(t.tenantId, t.status),
}));

export type NpsResponse = typeof npsResponses.$inferSelect;
export type RecoveryCase = typeof recoveryCases.$inferSelect;
