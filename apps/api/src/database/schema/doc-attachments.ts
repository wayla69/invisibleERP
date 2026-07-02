import { pgTable, bigserial, bigint, text, timestamp, jsonb, index, primaryKey } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// 0228 — evidence images (supplier invoice / delivery receipt / other) pinned to a document. PO first;
// doc_type is extensible (PR/GR/AP). Stored as data-URLs in-DB (same model as item_images; ~2MB cap
// enforced in the service). Uploaded from the web PO screen or over the LINE OA chat (`attach <PO no>`
// then a photo). Strengthens 3-way-match documentation (EXP-01 evidence; no control change).
export const docAttachments = pgTable('doc_attachments', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  docType: text('doc_type').notNull(),
  docNo: text('doc_no').notNull(),
  kind: text('kind').notNull().default('invoice'), // invoice | receipt | other
  filename: text('filename'),
  dataUrl: text('data_url').notNull(),
  note: text('note'),
  source: text('source').notNull().default('web'), // web | line
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byDoc: index('idx_doc_attachments_doc').on(t.tenantId, t.docType, t.docNo) }));

// Short-lived per-LINE-user conversation state for multi-step chat flows (first use: `attach <PO no>` →
// the next photo from that user binds to the document). One live state per (tenant, LINE user).
export const lineChatStates = pgTable('line_chat_states', {
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  lineUserId: text('line_user_id').notNull(),
  kind: text('kind').notNull(),
  payload: jsonb('payload').notNull().default({}),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.tenantId, t.lineUserId] }) }));
