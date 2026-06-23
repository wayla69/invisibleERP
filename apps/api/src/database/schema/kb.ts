import { pgTable, bigserial, bigint, integer, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Phase D2 — RAG knowledge base. Documents (policies/SOPs/contracts) are chunked and each chunk gets an
// embedding stored as a plain number[] (jsonb) so retrieval works on PGlite without the pgvector
// extension; cosine is computed in-service. Swap to a pgvector column + index in prod for scale.
export const kbDocuments = pgTable('kb_documents', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  title: text('title').notNull(),
  source: text('source'),          // e.g. policy id / file name / url
  createdBy: text('created_by'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const kbChunks = pgTable('kb_chunks', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  docId: bigint('doc_id', { mode: 'number' }).references(() => kbDocuments.id),
  ord: integer('ord').notNull(),   // chunk order within the document
  content: text('content').notNull(),
  embedding: jsonb('embedding').notNull(), // number[] (L2-normalized)
  createdAt: timestamp('created_at').defaultNow(),
});
