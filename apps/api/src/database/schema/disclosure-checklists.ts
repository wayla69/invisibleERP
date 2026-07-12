import { pgTable, bigserial, bigint, text, integer, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// CLS-02 (GL-26) — Disclosure / close-package checklist (governed close binder).
// A per-period disclosure checklist governs the reporting package (statutory FS / SEC disclosure controls):
// each standard-driven disclosure item carries an owner, a standard reference (TFRS/IFRS/SEC), a status
// (Open/Complete/NA) and an optional support-doc reference (evidence pinned via doc_attachments, docType DISC).
// The checklist can only be Reviewed once EVERY item is Complete/NA, and the reviewer MUST differ from the
// preparer (maker-checker SoD) before the financials are Issued. Posts NOTHING to the GL (detective/monitoring).
export const disclosureChecklists = pgTable('disclosure_checklists', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  checklistNo: text('checklist_no').notNull(),         // 'DISC-YYYYMMDD-NNN' — also the doc_attachments docNo
  period: text('period').notNull(),                    // 'YYYY-MM'
  title: text('title'),
  status: text('status').notNull().default('Draft'),   // 'Draft' | 'Reviewed' | 'Issued'
  preparedBy: text('prepared_by'),
  preparedAt: timestamp('prepared_at', { withTimezone: true }).defaultNow(),
  reviewedBy: text('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  issuedBy: text('issued_by'),
  issuedAt: timestamp('issued_at', { withTimezone: true }),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqNo: uniqueIndex('uq_disclosure_checklists_no').on(t.checklistNo),
  byTenant: index('idx_disclosure_checklists_tenant').on(t.tenantId, t.period),
}));

export const disclosureItems = pgTable('disclosure_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  checklistId: bigint('checklist_id', { mode: 'number' }).notNull().references(() => disclosureChecklists.id),
  seq: integer('seq').notNull(),
  item: text('item').notNull(),                        // the disclosure requirement
  standardRef: text('standard_ref'),                   // TFRS/IFRS/SEC reference
  owner: text('owner'),
  status: text('status').notNull().default('Open'),    // 'Open' | 'Complete' | 'NA'
  supportDocRef: text('support_doc_ref'),              // evidence ref (doc_attachments docType DISC / URL / note)
  completedBy: text('completed_by'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byChecklist: index('idx_disclosure_items_tenant').on(t.tenantId, t.checklistId),
}));

export type DisclosureChecklist = typeof disclosureChecklists.$inferSelect;
export type DisclosureItem = typeof disclosureItems.$inferSelect;
