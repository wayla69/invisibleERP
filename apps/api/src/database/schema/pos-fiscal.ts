import { pgTable, bigserial, bigint, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Append-only, hash-chained electronic journal (RD requirement for POS).
// hash = sha256(prev_hash + canonical(payload)); any edit breaks the chain → tamper-evident.
export const posJournal = pgTable('pos_journal', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  docType: text('doc_type').notNull(), // SALE | VOID | REFUND | TAXINV | NOSALE
  docNo: text('doc_no'),
  action: text('action'),
  payload: jsonb('payload').notNull(),
  prevHash: text('prev_hash'),
  hash: text('hash').notNull(),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// RD/ETDA e-Tax Invoice & e-Receipt submissions via a service provider (mock + real SP).
export const etaxSubmissions = pgTable('etax_submissions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  docNo: text('doc_no').notNull(),
  provider: text('provider').default('mock'),
  status: text('status').default('Pending'), // Pending | Accepted | Rejected
  providerRef: text('provider_ref'),
  rdResponse: jsonb('rd_response'),
  submittedBy: text('submitted_by'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
