// Build immutable seller/payer snapshots from a tenant row so an issued legal document never changes
// when the tenant record is later edited.

export function tenantAddress(t: any): string {
  const parts = [
    t.addressLine1, t.addressLine2,
    t.subDistrict ? `ตำบล/แขวง ${t.subDistrict}` : null,
    t.district ? `อำเภอ/เขต ${t.district}` : null,
    t.province ? `จังหวัด ${t.province}` : null,
    t.postalCode,
  ].filter(Boolean);
  const structured = parts.join(' ');
  return structured || t.address || '-'; // fall back to legacy free-text address
}

export function branchLabel(t: any): string {
  if (t.branchLabelTh) return t.branchLabelTh;
  const code = String(t.branchCode ?? '00000');
  return code === '00000' ? 'สำนักงานใหญ่' : `สาขาที่ ${code}`;
}

// seller block for tax invoices (ม.86/4)
export function sellerSnapshot(t: any) {
  return {
    sellerName: t.legalName || t.name,
    sellerTaxId: String(t.taxId ?? ''),
    sellerBranchCode: String(t.branchCode ?? '00000'),
    sellerBranchLabel: branchLabel(t),
    sellerAddress: tenantAddress(t),
  };
}

// payer block for WHT 50 ทวิ (ผู้มีหน้าที่หักภาษี ณ ที่จ่าย = the tenant)
export function payerSnapshot(t: any) {
  return {
    payerName: t.legalName || t.name,
    payerTaxId: String(t.taxId ?? ''),
    payerBranchCode: String(t.branchCode ?? '00000'),
    payerAddress: tenantAddress(t),
  };
}

// 13-digit Tax ID display: X-XXXX-XXXXX-XX-X
export function formatTaxId(id: string | null | undefined): string {
  const d = String(id ?? '').replace(/\D/g, '');
  if (d.length !== 13) return String(id ?? '-');
  return `${d[0]}-${d.slice(1, 5)}-${d.slice(5, 10)}-${d.slice(10, 12)}-${d[12]}`;
}

// validate a Thai 13-digit Tax ID (length + mod-11 check digit)
export function isValidTaxId(id: string | null | undefined): boolean {
  const d = String(id ?? '').replace(/\D/g, '');
  if (!/^\d{13}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(d[i]) * (13 - i);
  const check = (11 - (sum % 11)) % 10;
  return check === Number(d[12]);
}
