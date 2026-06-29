import { pgTable, bigserial, bigint, text, jsonb, timestamp, date } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// PDPA (Thailand) — DSAR workflow + erasure ledger (migration 0180). Tenant-scoped + RLS.
export const dsarRequests = pgTable('dsar_requests', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  subjectType: text('subject_type').notNull(), // member | customer | employee | user
  subjectRef: text('subject_ref').notNull(),
  requestType: text('request_type').notNull(), // access | rectification | erasure | portability | objection
  status: text('status').notNull().default('received'), // received | in_progress | completed | rejected
  details: text('details'),
  result: jsonb('result'),
  requestedBy: text('requested_by'),
  handledBy: text('handled_by'),
  dueDate: date('due_date'), // statutory 30-day clock
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});
export type DsarRequest = typeof dsarRequests.$inferSelect;

// Append-only erasure ledger: drives read-time pseudonymisation of the immutable, hash-chained audit_log
// (the stored rows are never mutated — AC-10/AC-16 integrity preserved — but the subject's PII is masked
// wherever the trail is surfaced).
export const pdpaErasures = pgTable('pdpa_erasures', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  subjectType: text('subject_type').notNull(),
  subjectId: bigint('subject_id', { mode: 'number' }),
  pseudonym: text('pseudonym').notNull(),
  erasedValues: jsonb('erased_values').notNull().default([]), // PII strings to mask at read-time
  dsarId: bigint('dsar_id', { mode: 'number' }).references(() => dsarRequests.id),
  erasedBy: text('erased_by'),
  erasedAt: timestamp('erased_at', { withTimezone: true }).notNull().defaultNow(),
});
export type PdpaErasure = typeof pdpaErasures.$inferSelect;
