import { pgTable, bigserial, bigint, text, jsonb, timestamp, date, boolean } from 'drizzle-orm/pg-core';
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

// RoPA — Records of Processing Activities (PDPA มาตรา 39 / GDPR Art.30, PDPA-03, migration 0282). A maintained
// inventory of how the company processes personal data: one row per processing activity with its purpose,
// legal basis, data categories/subjects, recipients + sub-processors, retention, cross-border basis and
// security measures. The register an auditor/DPA asks for. Tenant-scoped + RLS (like the DSAR tables).
export const ropaActivities = pgTable('ropa_activities', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  name: text('name').notNull(),                       // e.g. 'Loyalty membership', 'Payroll'
  purpose: text('purpose').notNull(),                 // why the data is processed
  legalBasis: text('legal_basis').notNull(),          // consent | contract | legal_obligation | legitimate_interest | vital_interest | public_task
  dataCategories: jsonb('data_categories').notNull().default([]), // ['name','phone','national_id',…]
  dataSubjects: jsonb('data_subjects').notNull().default([]),     // ['customers','employees','members']
  recipients: jsonb('recipients').notNull().default([]),          // internal/external recipients
  subProcessors: jsonb('sub_processors').notNull().default([]),   // ['Stripe','Anthropic','Sentry']
  retentionPeriod: text('retention_period'),          // e.g. '5 years after contract end'
  crossBorder: text('cross_border'),                  // cross-border transfer basis (PDPA s.28-29 / GDPR Ch.V); null = domestic only
  securityMeasures: text('security_measures'),        // encryption, access control, …
  active: boolean('active').notNull().default(true),
  createdBy: text('created_by'),
  updatedBy: text('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export type RopaActivity = typeof ropaActivities.$inferSelect;
