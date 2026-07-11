import { pgTable, bigserial, bigint, text, numeric, boolean, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// ── QMS-3 — Certificate of Analysis (CoA) capture + out-of-spec release approval (QC-03) ──
// Lots exist (lot_ledger, read-only) but there is no concept of a quality spec, a measured characteristic,
// or a Certificate of Analysis, and no gate on releasing an out-of-spec lot. These tables add CoA capture
// against a received/produced lot (text lot_no ref — the lot ledger is NOT rewritten), with a maker-checker
// deviation approval to release an out-of-spec lot. Tenant-scoped (canonical 0232 RLS loop; migration 0333).

// Per-item quality specification: an acceptable range [min,max] for a measured characteristic.
export const qualitySpecs = pgTable(
  'quality_specs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    specNo: text('spec_no').notNull(),
    itemId: text('item_id').notNull(),
    characteristic: text('characteristic').notNull(), // e.g. Moisture %, pH, Purity %
    uom: text('uom'),
    minValue: numeric('min_value', { precision: 18, scale: 4 }),
    maxValue: numeric('max_value', { precision: 18, scale: 4 }),
    targetValue: numeric('target_value', { precision: 18, scale: 4 }),
    active: boolean('active').notNull().default(true),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    byTenant: index('idx_quality_specs_tenant').on(t.tenantId, t.itemId),
    uqSpecNo: unique('uq_quality_specs_no').on(t.tenantId, t.specNo),
  }),
);

// Certificate of Analysis against a lot. overall_result = pass|fail|pending (fail = out-of-spec). A fail CoA
// can only be released by a DIFFERENT user than the recorder, WITH a deviation_reason (QC-03 maker-checker).
export const coaCertificates = pgTable(
  'coa_certificates',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    coaNo: text('coa_no').notNull(),
    lotNo: text('lot_no').notNull(), // text ref to lot_ledger.lot_no
    itemId: text('item_id').notNull(),
    source: text('source').notNull().default('incoming'), // incoming | production
    overallResult: text('overall_result').notNull().default('pending'), // pass | fail | pending
    released: boolean('released').notNull().default(false),
    releaseStatus: text('release_status').notNull().default('held'), // held | released | rejected
    releasedBy: text('released_by'),
    deviationReason: text('deviation_reason'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => ({
    byTenant: index('idx_coa_certificates_tenant').on(t.tenantId, t.releaseStatus),
    byLot: index('idx_coa_certificates_lot').on(t.lotNo),
    uqCoaNo: unique('uq_coa_certificates_no').on(t.tenantId, t.coaNo),
  }),
);

// Child measured results per characteristic — the spec window snapshot + the actual + pass/fail verdict.
export const coaResults = pgTable(
  'coa_results',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    coaId: bigint('coa_id', { mode: 'number' }).notNull().references(() => coaCertificates.id),
    characteristic: text('characteristic').notNull(),
    uom: text('uom'),
    specMin: numeric('spec_min', { precision: 18, scale: 4 }),
    specMax: numeric('spec_max', { precision: 18, scale: 4 }),
    actualValue: numeric('actual_value', { precision: 18, scale: 4 }),
    result: text('result').notNull().default('pass'), // pass | fail
  },
  (t) => ({
    byTenant: index('idx_coa_results_tenant').on(t.tenantId),
    byCoa: index('idx_coa_results_coa').on(t.coaId),
  }),
);
