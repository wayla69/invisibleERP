import type { DocParty } from './doc-html';

// Map a `tenants` row (the company printing a document) to the seller/issuer party block shown on the
// business documents. Composes the structured Thai address from its parts and falls back to the legacy
// `address` string; a null tenant (HQ/bypass caller with no tenant profile) yields a generic placeholder
// so the document still renders. Shared by the quotation / delivery / AR-invoice renderers.
export function sellerParty(t: any | null | undefined): DocParty {
  const address = t
    ? [t.addressLine1, t.addressLine2, t.subDistrict, t.district, t.province, t.postalCode].filter(Boolean).join(' ') || (t.address ?? '')
    : '';
  return {
    name: t?.legalName || t?.name || 'บริษัทของฉัน',
    address: address || '-',
    tax_id: t?.taxId ?? null,
    branch_label: t?.branchLabelTh ?? 'สำนักงานใหญ่',
    phone: t?.phone ?? null,
    email: t?.email ?? null,
    logo_url: t?.logoUrl ?? null,
  };
}
