// Document templates (Platform Phase 10 — A3). A per-tenant, no-code registry that customizes the
// PRESENTATION of customer-facing documents (receipt first; tax invoices / quotations / POs / payslips
// follow). `config` is a presentation-only JSON blob (header/body/footer/paper knobs) — it NEVER controls
// amounts and NEVER omits a legally-mandatory field, and it posts nothing to the ledger. One row per
// (tenant, doc_type) is flagged is_default = the active template consumed at render time.
import { pgTable, bigserial, bigint, text, jsonb, boolean, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const documentTemplates = pgTable('document_templates', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  docType: text('doc_type').notNull(),                 // receipt | tax_invoice_abbreviated | tax_invoice_full | quotation | purchase_order | payslip
  name: text('name').notNull(),
  config: jsonb('config').notNull().default({}),       // presentation-only knobs; see printing/receipt-render.ts
  isDefault: boolean('is_default').notNull().default(false), // the active template for this (tenant, doc_type)
  active: boolean('active').notNull().default(true),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export type DocumentTemplate = typeof documentTemplates.$inferSelect;
