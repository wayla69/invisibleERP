import { pgTable, bigserial, bigint, text, numeric, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// ── QMS-1 (QC-01) — Non-Conformance (NCR) register with maker-checker disposition ──
// A failed quality inspection (or a customer/supplier complaint) is promoted to a first-class NCR. An NCR whose
// financial disposition (scrap / use-as-is / return) may post a GL write-off is created as `pending_disposition`
// and the disposition is applied — and any Dr 5810 / Cr <inventory> write-off posted — ONLY when a DIFFERENT
// user approves (dispositioned_by ≠ raised_by → 403 SOD_SELF_APPROVAL). Reject returns the NCR to `open`.

// A small per-tenant defect-code lookup (reason taxonomy for an NCR).
export const defectCodes = pgTable(
  'defect_codes',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    code: text('code').notNull(),
    name: text('name'),
    category: text('category'), // e.g. dimensional | cosmetic | functional | documentation
    active: boolean('active').notNull().default(true),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    byTenant: index('idx_defect_codes_tenant').on(t.tenantId),
    byTenantCode: uniqueIndex('idx_defect_codes_tenant_code').on(t.tenantId, t.code),
  }),
);

export const nonConformances = pgTable(
  'non_conformances',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    ncrNo: text('ncr_no').notNull(),
    source: text('source').notNull().default('in_process'), // incoming | in_process | customer | supplier
    refType: text('ref_type'),  // WO | GR | INSP | (optional link)
    refDoc: text('ref_doc'),    // the source document / inspection no.
    itemId: text('item_id'),
    itemDescription: text('item_description'),
    defectCode: text('defect_code'),
    severity: text('severity').notNull().default('minor'), // minor | major | critical
    qty: numeric('qty', { precision: 14, scale: 3 }).default('0'),
    unitCost: numeric('unit_cost', { precision: 16, scale: 4 }).default('0'),
    description: text('description'),
    // scrap | use_as_is | return | rework — the disposition proposed by the raiser
    proposedDisposition: text('proposed_disposition'),
    // open → pending_disposition → dispositioned → closed  (reject sends pending_disposition back to open)
    status: text('status').notNull().default('open'),
    writeOffValue: numeric('write_off_value', { precision: 16, scale: 2 }).default('0'),
    entryNo: text('entry_no'), // GL ref if the disposition posted a scrap write-off
    raisedBy: text('raised_by'),
    dispositionedBy: text('dispositioned_by'),
    dispositionNotes: text('disposition_notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => ({
    byTenant: index('idx_non_conformances_tenant').on(t.tenantId, t.status),
    byTenantNo: uniqueIndex('idx_non_conformances_tenant_no').on(t.tenantId, t.ncrNo),
  }),
);

export type NonConformance = typeof nonConformances.$inferSelect;
export type DefectCode = typeof defectCodes.$inferSelect;
