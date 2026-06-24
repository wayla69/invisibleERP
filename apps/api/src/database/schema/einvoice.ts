// C3 (Platform Phase 22) — pluggable tax + e-invoicing engine. An EInvoiceProvider (per country) submits a
// canonical invoice to the authority; a deterministic STUB is the default (CI-safe), real adapters (TH RD,
// MY MyInvois, SG InvoiceNow, …) swap in behind the same interface. Submissions are logged + idempotent by
// doc_ref. Per-tenant provider config stores (encrypted, in prod) credentials. Read-of-invoice → external
// send; posts NOTHING to the GL. RLS-scoped.
import { pgTable, bigserial, bigint, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const einvoiceConfig = pgTable('einvoice_config', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  providerKey: text('provider_key').notNull(),
  config: jsonb('config').default({}),          // non-secret config (real creds would be AES-256-GCM encrypted)
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const einvoiceSubmissions = pgTable('einvoice_submissions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  docRef: text('doc_ref').notNull(),
  provider: text('provider'),
  status: text('status').notNull(),             // accepted | rejected
  payloadHash: text('payload_hash'),
  response: jsonb('response').default({}),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).defaultNow(),
});

export type EInvoiceSubmission = typeof einvoiceSubmissions.$inferSelect;
