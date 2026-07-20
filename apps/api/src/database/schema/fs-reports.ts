import { pgTable, bigserial, bigint, integer, numeric, text, boolean, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// ── FIN-4: Statutory FS pack — configurable financial-report builder ────────────
// A tenant-defined financial-statement layout: the reusable row-grouping ("financial report builder")
// that the notes / SOCE / DBD e-Filing exports all ride on. `statementType` selects which base figures
// the renderer pulls (BS = cumulative as-of balances; P&L = period figures; NOTES = per-note account
// mapping + policy-note text). `config` is the JSON layout (groups / notes / policy text). Tenant-scoped
// (RLS + a leading (tenant_id, …) index); `code` is unique per tenant so a buyer curates named packs.
export const fsReportDefinitions = pgTable('fs_report_definitions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  // 'bs' | 'pl' | 'soce' | 'notes'
  statementType: text('statement_type').notNull().default('pl'),
  config: jsonb('config').notNull().default({}),
  active: boolean('active').notNull().default(true),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_fsrd_tenant').on(t.tenantId, t.statementType),
  uqTenantCode: uniqueIndex('uq_fsrd_tenant_code').on(t.tenantId, t.code),
}));

export type FsReportDefinition = typeof fsReportDefinitions.$inferSelect;

// ── FIN-4 GL-29: financial-statement issuance review & approval (maker-checker) ──
// A preparer submits a period's statutory statement pack for review, snapshotting the key figures + a hash
// (the "as-issued" record); a DIFFERENT user approves it (self-approval → SOD_VIOLATION). The formatted FS
// pack reads the latest Approved review for the period/ledger to stamp "reviewed & approved" vs "unaudited",
// and flags a re-review when the live figures drift from the approved hash. Tenant-scoped (RLS 0232 + index).
export const fsStatementReviews = pgTable('fs_statement_reviews', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  fiscalYear: integer('fiscal_year').notNull(),
  ledger: text('ledger').notNull().default('LEADING'),
  industry: text('industry'),
  status: text('status').notNull().default('PendingApproval'), // PendingApproval | Approved
  totalAssets: numeric('total_assets', { precision: 18, scale: 2 }),
  totalLiabilities: numeric('total_liabilities', { precision: 18, scale: 2 }),
  totalEquity: numeric('total_equity', { precision: 18, scale: 2 }),
  revenue: numeric('revenue', { precision: 18, scale: 2 }),
  netIncome: numeric('net_income', { precision: 18, scale: 2 }),
  figuresHash: text('figures_hash').notNull(),
  preparedBy: text('prepared_by'),
  preparedAt: timestamp('prepared_at', { withTimezone: true }).defaultNow(),
  approvedBy: text('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
}, (t) => ({
  byTenant: index('idx_fs_statement_reviews_tenant').on(t.tenantId, t.fiscalYear, t.status),
}));

export type FsStatementReview = typeof fsStatementReviews.$inferSelect;
