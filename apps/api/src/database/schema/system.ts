import { pgTable, bigserial, bigint, text, integer, timestamp, boolean, primaryKey } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { roleEnum } from './enums';

export const notifications = pgTable('notifications', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  targetTenantId: bigint('target_tenant_id', { mode: 'number' }).references(() => tenants.id),
  targetRole: roleEnum('target_role'),
  message: text('message'), // Thai
  messageEn: text('message_en'),
  isRead: boolean('is_read').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// polymorphic audit (แทน _log_status)
export const docStatusLog = pgTable('doc_status_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  docType: text('doc_type'),
  docNo: text('doc_no'),
  oldStatus: text('old_status'),
  newStatus: text('new_status'),
  changedBy: text('changed_by'),
  changedAt: timestamp('changed_at', { withTimezone: true }).defaultNow(),
  remarks: text('remarks'),
});

// คุมรูปแบบเลขเอกสาร
export const docNumberConfig = pgTable('doc_number_config', {
  docType: text('doc_type').primaryKey(),
  format: text('format').notNull(),
});

// atomic per-(doc_type, day) counter — แก้ race ของ COUNT(*)+1 ใน V1 (upsert-returning)
export const docCounters = pgTable(
  'doc_counters',
  {
    docType: text('doc_type').notNull(),
    day: text('day').notNull(),
    n: integer('n').notNull().default(0),
  },
  (t) => ({ pk: primaryKey({ columns: [t.docType, t.day] }) }),
);
