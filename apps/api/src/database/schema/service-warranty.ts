// SVC-2 — Warranty & Entitlement registry (net-new after-sales foundation; distinct from the #666
// subscription/SLA service spine in ./service.ts). Three tenant-scoped tables:
//   • warranty_terms      — a per-tenant catalogue of warranty offerings (coverage months + type).
//   • installed_base       — the serialized-unit / asset registry: a sold unit (serial) tied to a customer,
//                            an item, and a warranty term, with a computed warranty_end window.
//   • warranty_claims      — a claim against an installed_base unit, gated by the SVC-01 coverage-authorization
//                            control (in-coverage → auto-authorized free; out-of-coverage free service needs a
//                            DIFFERENT authorizer than the requester → SOD_SELF_APPROVAL).
// Each table is RLS-scoped (canonical 0232-form tenant_isolation, migration 0329) with a leading (tenant_id,…)
// index. Warranty claims post NO GL in v1 (a service-order / cost posting is future work).
import { pgTable, bigserial, bigint, text, numeric, boolean, date, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// coverage_type: 'parts' | 'labor' | 'full'
export const warrantyTerms = pgTable('warranty_terms', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  termCode: text('term_code').notNull(),
  name: text('name').notNull(),
  coverageMonths: bigint('coverage_months', { mode: 'number' }).notNull().default(12),
  coverageType: text('coverage_type').notNull().default('full'), // parts | labor | full
  active: boolean('active').notNull().default(true),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_warranty_terms_tenant').on(t.tenantId, t.active),
  uqCode: uniqueIndex('uq_warranty_terms_code').on(t.tenantId, t.termCode),
}));

// status: 'active' | 'expired' | 'void'
export const installedBase = pgTable('installed_base', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  serialNo: text('serial_no').notNull(),
  itemCode: text('item_code').notNull(),
  itemId: bigint('item_id', { mode: 'number' }),
  customerId: bigint('customer_id', { mode: 'number' }),
  customerName: text('customer_name'),
  soldDate: date('sold_date').notNull(),
  warrantyTermId: bigint('warranty_term_id', { mode: 'number' }).references(() => warrantyTerms.id),
  warrantyStart: date('warranty_start').notNull(),
  warrantyEnd: date('warranty_end').notNull(), // = sold_date + term.coverage_months (computed on register)
  coverageType: text('coverage_type').notNull().default('full'), // snapshot of the term at sale
  status: text('status').notNull().default('active'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_installed_base_tenant').on(t.tenantId, t.status),
  uqSerial: uniqueIndex('uq_installed_base_serial').on(t.tenantId, t.serialNo),
  byEnd: index('idx_installed_base_end').on(t.tenantId, t.warrantyEnd),
}));

// disposition: 'repair' | 'replace' | 'reject'
// status: 'pending' | 'authorized' | 'closed'
export const warrantyClaims = pgTable('warranty_claims', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  claimNo: text('claim_no').notNull(),
  installedBaseId: bigint('installed_base_id', { mode: 'number' }).notNull().references(() => installedBase.id),
  reportedDate: date('reported_date').notNull(),
  fault: text('fault').notNull(),
  coverageKind: text('coverage_kind').notNull().default('full'), // what is being claimed: parts | labor | full
  disposition: text('disposition'), // repair | replace | reject
  status: text('status').notNull().default('pending'),
  isInCoverage: boolean('is_in_coverage').notNull().default(false), // snapshot of the coverage check at raise
  charge: numeric('charge', { precision: 18, scale: 4 }).notNull().default('0'),
  requestedBy: text('requested_by'),
  authorizedBy: text('authorized_by'),
  rejectReason: text('reject_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
}, (t) => ({
  byTenant: index('idx_warranty_claims_tenant').on(t.tenantId, t.status),
  uqNo: uniqueIndex('uq_warranty_claims_no').on(t.tenantId, t.claimNo),
  byUnit: index('idx_warranty_claims_unit').on(t.installedBaseId),
}));

export type WarrantyTerm = typeof warrantyTerms.$inferSelect;
export type InstalledBaseUnit = typeof installedBase.$inferSelect;
export type WarrantyClaim = typeof warrantyClaims.$inferSelect;
