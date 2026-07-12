// SVC-6 — Service Cloud: Knowledge Base + Case Deflection (net-new; complements the SVC-4/5 case surface in
// ./service-cases.ts). Two tenant-scoped tables:
//   • kb_articles      — a per-tenant knowledge-base article with a GOVERNED publish lifecycle
//                        (draft → published → archived). An article reaches customers only via a controlled
//                        publish by a DIFFERENT user than the author (SVC-06 maker-checker) — no unreviewed
//                        knowledge is published. Carries usage counters (views / helpful / not_helpful).
//   • kb_deflections   — the case-deflection log: each KB-assisted interaction records the search query, the
//                        article involved, and whether it DEFLECTED (customer self-served, no case) or a case
//                        was still opened — so self-service effectiveness / deflection rate is measurable.
// Each table is RLS-scoped (canonical 0232-form tenant_isolation, migration 0353) with a leading (tenant_id,…)
// index. No GL post (knowledge/deflection are operational, never financial).
import { pgTable, bigserial, bigint, text, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// status: 'draft' | 'published' | 'archived'  (governed lifecycle)
export const kbArticles = pgTable('kb_articles', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  articleNo: text('article_no').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  category: text('category'),
  tags: text('tags'), // free-text, comma/space separated — searched alongside title/body
  status: text('status').notNull().default('draft'),
  author: text('author'),
  publishedBy: text('published_by'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  views: bigint('views', { mode: 'number' }).notNull().default(0),
  helpful: bigint('helpful', { mode: 'number' }).notNull().default(0),
  notHelpful: bigint('not_helpful', { mode: 'number' }).notNull().default(0),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_kb_articles_tenant').on(t.tenantId, t.status),
  uqNo: uniqueIndex('uq_kb_articles_no').on(t.tenantId, t.articleNo),
}));

// A KB-assisted interaction. deflected=true → the customer self-served (no case opened); deflected=false → a
// case was opened despite the article (case_id set). The population a service manager reads for deflection rate.
export const kbDeflections = pgTable('kb_deflections', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  query: text('query'),
  articleId: bigint('article_id', { mode: 'number' }).references(() => kbArticles.id),
  deflected: boolean('deflected').notNull().default(false),
  caseId: bigint('case_id', { mode: 'number' }), // set when a case was opened despite the article
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_kb_deflections_tenant').on(t.tenantId, t.deflected),
}));

export type KbArticle = typeof kbArticles.$inferSelect;
export type KbDeflection = typeof kbDeflections.$inferSelect;
