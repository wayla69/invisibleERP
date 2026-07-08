// Shared pure pieces of the procurement module (docs/38 §3 procurement decomposition, PR-1 — the
// canary-proof cut, mirroring bi report-registry / projects.helpers): the `n` coercion helper, the public
// DTO interfaces and the vendor row shapers, moved VERBATIM. No DI/constructor change — the goldenmaster
// and writeflow harnesses construct `new ProcurementService(db, docNo, statusLog)` POSITIONALLY, so (like
// projects, unlike bi) any future sub-service must be built in the constructor BODY, never DI-appended.
export const n = (v: unknown) => Number(v ?? 0);

// project_code / boq_line_id (M0, docs/32) — optionally raise a requisition/PO against a project's BoQ so
// material spend is dimensioned to the project. Nullable throughout → non-project buys are unaffected.
export interface CreatePrDto { items: { item_id: string; item_description?: string; request_qty: number; uom?: string; required_date?: string; reason?: string; boq_line_id?: number }[]; remarks?: string; priority?: string; amount?: number; project_code?: string }
export interface CreatePoDto { vendor_id?: number; vendor_name?: string; expected_date?: string; remarks?: string; currency?: string; fx_rate?: number; project_code?: string; items: { item_id: string; item_description?: string; order_qty: number; unit_price: number; uom?: string; is_capital?: boolean; boq_line_id?: number }[];
  // M2 (docs/32) — internal flags set by the PMR auto-draft path (not exposed on the public PO create form):
  // `draft` opens the PO as Draft (not Pending) and skips the approval workflow so procurement reviews it
  // before committing; `authorized_over_budget` lets the BoQ-line reservation exceed the budget (the PMR
  // approval IS the authorisation to overrun). project_id is passed through directly when known.
  draft?: boolean; authorized_over_budget?: boolean; project_id?: number }
export interface CreateGrDto { po_no: string; remarks?: string; items: { item_id: string; received_qty: number; lot_no?: string; expiry_date?: string; unit_cost?: number; uom?: string }[] }
export interface UpsertSupplierPriceDto { vendor_id: number; item_id: string; item_description?: string; uom?: string; currency?: string; unit_price: number; min_qty?: number; effective_from: string; effective_to?: string; notes?: string }
// A single reconciled PR→PO line. pr_line_id links it back to the exact pr_items row (precise stamping in the
// split path); set_preferred also records the chosen vendor as the item's default supplier (learn-as-you-buy).
export interface ConvLine { pr_line_id?: number; item_id: string; item_description?: string; create_item?: boolean; order_qty: number; unit_price: number; uom?: string; is_capital?: boolean; set_preferred?: boolean }

export function shapeVendorRelationship(r: any, other: { vendor_id: number; name: string }, direction: 'outgoing' | 'incoming') {
  return { id: Number(r.id), rel_type: r.relType, direction, party: other, note: r.note ?? null, created_by: r.createdBy, created_at: r.createdAt };
}

export function shapeVendorAddress(a: any) {
  return {
    id: Number(a.id), address_type: a.addressType, address_line1: a.addressLine1 ?? null, address_line2: a.addressLine2 ?? null,
    sub_district: a.subDistrict ?? null, district: a.district ?? null, province: a.province ?? null, postal_code: a.postalCode ?? null,
    is_primary: a.isPrimary === true, created_by: a.createdBy, created_at: a.createdAt,
  };
}
export function shapeVendorContact(c: any) {
  return { id: Number(c.id), name: c.name, title: c.title ?? null, phone: c.phone ?? null, email: c.email ?? null, notes: c.notes ?? null, is_primary: c.isPrimary === true, created_by: c.createdBy, created_at: c.createdAt };
}
