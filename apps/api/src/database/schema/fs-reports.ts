import { pgTable, bigserial, bigint, text, boolean, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
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
