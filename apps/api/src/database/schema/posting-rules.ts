import { pgTable, bigserial, bigint, text, boolean, smallint, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const postingEventTypes = pgTable('posting_event_types', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
});

export const postingRules = pgTable('posting_rules', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  eventType: text('event_type').notNull().references(() => postingEventTypes.key),
  legOrder: smallint('leg_order').notNull(),
  role: text('role').notNull(),       // semantic slot: 'inventory', 'ap_control', 'cogs', 'vat_output', etc.
  side: text('side').notNull(),       // 'DR' or 'CR'
  accountCode: text('account_code').notNull(),
  dimensionSource: text('dimension_source'), // 'branch_id'|'project_id'|null — which ctx field to stamp
  condition: jsonb('condition'),      // optional filter e.g. {"category":"exempt"}
  active: boolean('active').default(true),
  // GL-24 (0331): rule changes are governed config — API writes land PendingApproval and only a
  // DIFFERENT user's approval activates them. DB default 'Approved' grandfathers pre-existing rows
  // and direct harness seeds; the resolver consumes active + Approved rows only.
  status: text('status').notNull().default('Approved'), // 'PendingApproval' | 'Approved' | 'Rejected'
  createdBy: text('created_by'),
  approvedBy: text('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqRule: uniqueIndex('uq_posting_rules').on(
    // Drizzle doesn't support COALESCE in index definitions — the raw SQL migration uses
    // COALESCE(tenant_id,0) for correct null-uniqueness. Here we just list the columns so
    // Drizzle knows the index exists.
    t.tenantId, t.eventType, t.legOrder,
  ),
}));

// GL-24 append-only audit trail: every CREATE/APPROVE/REJECT/DEACTIVATE on a posting rule (0331).
export const postingRuleAudit = pgTable('posting_rule_audit', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  ruleId: bigint('rule_id', { mode: 'number' }),
  action: text('action').notNull(),
  actor: text('actor'),
  detail: jsonb('detail'),
  at: timestamp('at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_posting_rule_audit_tenant').on(t.tenantId, t.ruleId),
}));

export type PostingRule = typeof postingRules.$inferSelect;
export type PostingEventType = typeof postingEventTypes.$inferSelect;

// GL-27 (0359): canonical Chart-of-Accounts maker-checker. A canonical account create/update/
// deactivate stages here and applies only on a DIFFERENT Admin's approval; with exactly ONE active
// Admin the change applies immediately, recorded as 'AutoApplied' (the single-Admin exception).
// PLATFORM table — the company column is created_tenant_id (context only, NOT tenant_id) so the
// generic RLS loop and the tenant-idx gate skip it (the canonical chart is global).
export const coaChangeRequests = pgTable('coa_change_requests', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  action: text('action').notNull(),                 // 'create' | 'update' | 'deactivate'
  accountCode: text('account_code').notNull(),
  payload: jsonb('payload'),
  before: jsonb('before'),
  status: text('status').notNull().default('PendingApproval'), // PendingApproval | Approved | Rejected | AutoApplied
  reason: text('reason'),
  createdBy: text('created_by'),
  createdTenantId: bigint('created_tenant_id', { mode: 'number' }).references(() => tenants.id),
  approvedBy: text('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byStatus: index('idx_coa_change_requests_status').on(t.status, t.id),
}));

export type CoaChangeRequest = typeof coaChangeRequests.$inferSelect;
