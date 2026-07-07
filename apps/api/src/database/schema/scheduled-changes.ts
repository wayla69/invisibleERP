// Scheduled (date-effective / future-dated) master-data changes (master-data audit Phase 12). A steward
// schedules a change to a master field to take effect on a future business date; an idempotent daily job
// (BI scheduler action `apply_scheduled_master_changes`) applies it once the date arrives. A change to a
// FRAUD-RELEVANT field (customer credit limit) is `sensitive` and staged `pending_approval` until a DISTINCT
// approver releases it (maker-checker, audit G7 / SoD R09). Tenant-scoped (RLS + change-audit). Migration 0278.
import { pgTable, bigserial, bigint, text, boolean, date, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const scheduledMasterChanges = pgTable('scheduled_master_changes', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  entity: text('entity').notNull(),
  entityKey: text('entity_key').notNull(),
  field: text('field').notNull(),
  newValue: text('new_value').notNull(),
  effectiveDate: date('effective_date').notNull(),
  status: text('status').notNull().default('scheduled'), // scheduled | pending_approval | applied | cancelled
  sensitive: boolean('sensitive').notNull().default(false),
  requestedBy: text('requested_by'),
  approvedBy: text('approved_by'),
  note: text('note'),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_scheduled_master_changes_tenant').on(t.tenantId),
  byDue: index('idx_scheduled_master_changes_due').on(t.tenantId, t.status, t.effectiveDate),
}));

export type ScheduledMasterChange = typeof scheduledMasterChanges.$inferSelect;
