// Wave 2 · 5.1 — VAT tax-point (จุดความรับผิดในการเสียภาษีมูลค่าเพิ่ม) resolver.
// Pure, unit-testable. Verified against ประมวลรัษฎากร (rd.go.th มาตรา 78 / 78/1, คำสั่ง ป.36/2536) — see
// docs/37-tax-point-model-design.md §1.
//
//   • Goods (สินค้า) — ม.78 (1): default tax point is DELIVERY (ส่งมอบ); but if transfer-of-ownership
//     (โอนกรรมสิทธิ์) / payment (ได้รับชำระราคา) / invoice-issued (ออกใบกำกับภาษี) occurs BEFORE delivery,
//     the tax point is that earlier event. ⇒ earliest-of {delivery, transfer, payment, invoice}.
//   • Services (บริการ) — ม.78/1 (1): default is PAYMENT (ได้รับชำระราคา); but if invoice-issued or
//     service-used (ได้ใช้บริการ) occurs BEFORE payment, that earlier event. ⇒ earliest-of {payment,
//     invoice, service-used}.
//   • Installment / hire-purchase (ม.78(2)) is a DIFFERENT rule (per-instalment due date) — see
//     `resolveInstallmentTaxPoints` below; it is NOT this function.
//
// Dates are business-day strings 'YYYY-MM-DD' (Asia/Bangkok via ymd()), which sort lexicographically =
// chronologically. This module is INERT until wired at issue time (5.1b) — nothing calls it in a decision
// path yet, so importing it changes no behaviour.

export type SupplyType = 'goods' | 'service';

export interface TaxPointInput {
  supplyType: SupplyType;
  invoiceDate: string;              // the document (tax-invoice) date — always present
  deliveryDate?: string | null;     // goods: ส่งมอบสินค้า
  transferDate?: string | null;     // goods: โอนกรรมสิทธิ์
  paymentDate?: string | null;      // both: ได้รับชำระราคา (incl. an advance that is consideration)
  serviceUsedDate?: string | null;  // services: ได้ใช้บริการ (self or other)
}

// Earliest non-empty 'YYYY-MM-DD' among the candidates (invoiceDate is always a candidate → never empty).
function earliest(dates: (string | null | undefined)[]): string {
  const valid = dates.filter((d): d is string => typeof d === 'string' && d.length > 0);
  return valid.reduce((a, b) => (b < a ? b : a));
}

export function resolveTaxPoint(input: TaxPointInput): string {
  if (input.supplyType === 'service') {
    // ม.78/1
    return earliest([input.paymentDate, input.serviceUsedDate, input.invoiceDate]);
  }
  // ม.78 (goods)
  return earliest([input.deliveryDate, input.transferDate, input.paymentDate, input.invoiceDate]);
}

// Installment / hire-purchase (ม.78(2), ป.36/2536): the tax point arises PER INSTALMENT on each instalment's
// due date, and a tax invoice is issued each instalment — NOT once at delivery. Relevant to the `realestate`
// installment-sale module (RE-01..03). Returns the ordered instalment due dates that each carry a tax point.
// (Phase 5.1e wires this; kept here so the whole tax-point rule set lives in one place.)
export function resolveInstallmentTaxPoints(dueDates: (string | null | undefined)[]): string[] {
  return dueDates.filter((d): d is string => typeof d === 'string' && d.length > 0).sort();
}
