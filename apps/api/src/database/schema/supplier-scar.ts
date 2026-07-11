import { pgTable, bigserial, bigint, text, date, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { vendors } from './procurement';

// QMS-4 (Supplier Corrective Action Request / 8D) — a FORMAL corrective-action request issued to a vendor.
// Supplier defects are already captured (gr_claims) and supplier performance already scored
// (supplier_scorecards via procurement.service.ts recomputeScorecard); this adds the missing 8D/SCAR spine:
// an issued corrective-action request WITH supplier-response tracking and a closure gate (QC-04) before the
// supplier is requalified. Sources from a gr_claim + vendor; does NOT re-derive scorecards.
//
// Lifecycle (status): open → supplier_responded → pending_closure → closed | rejected. Effectiveness is the
// closure verdict (effective | ineffective | null). closed_by MUST differ from raised_by (QC-04 maker-checker,
// SOD_SELF_APPROVAL) and closure is blocked until the supplier has responded and the 8D root_cause +
// corrective_action are populated (SCAR_INCOMPLETE).
export const supplierScars = pgTable('supplier_scars', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  scarNo: text('scar_no').notNull(),                 // SCAR-NNNNN (unique per tenant — partial unique index)
  vendorId: bigint('vendor_id', { mode: 'number' }).references(() => vendors.id),
  sourceClaimNo: text('source_claim_no'),            // nullable free-text ref to gr_claims.claim_no
  defectSummary: text('defect_summary').notNull(),
  severity: text('severity').notNull().default('major'), // minor | major | critical
  // 8D discipline fields (free text) — D3 containment, D4 root cause, D5/D6 corrective, D7 preventive.
  containment: text('containment'),
  rootCause: text('root_cause'),
  correctiveAction: text('corrective_action'),
  preventiveAction: text('preventive_action'),
  status: text('status').notNull().default('open'), // open | supplier_responded | pending_closure | closed | rejected
  effectiveness: text('effectiveness'),             // effective | ineffective | null
  dueDate: date('due_date'),
  raisedBy: text('raised_by'),
  supplierRespondedBy: text('supplier_responded_by'),
  supplierRespondedAt: timestamp('supplier_responded_at', { withTimezone: true }),
  closedBy: text('closed_by'),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  rejectReason: text('reject_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_supplier_scars_tenant').on(t.tenantId, t.status),
  byVendor: index('idx_supplier_scars_vendor').on(t.vendorId),
  byScarNo: uniqueIndex('idx_supplier_scars_no').on(t.tenantId, t.scarNo),
}));

export type SupplierScar = typeof supplierScars.$inferSelect;
