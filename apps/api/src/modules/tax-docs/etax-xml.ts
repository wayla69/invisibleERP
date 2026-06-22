// ETDA e-Tax Invoice XML — UBL 2.1 profile (ขมธอ.3-2560 / RD electronic tax invoice shape).
// Pure: builds the document from a tax-invoice DTO (the shape returned by TaxInvoiceService.getByDocNo).
// The XAdES digital signature + RD submission are layered on separately once a digital certificate is
// provisioned — this produces the unsigned, schema-shaped instance document.

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch] as string));
const amt = (v: unknown): string => (Math.round((Number(v) || 0) * 100) / 100).toFixed(2);

export interface EtaxParty { name?: string | null; tax_id?: string | null; branch_code?: string | null; address?: string | null }
export interface EtaxLine { line_no: number | string; description: string; qty?: number | null; uom?: string | null; unit_price?: number | null; amount: number }
export interface EtaxInvoice {
  doc_no: string;
  type?: string;
  issue_date: string;
  currency?: string;
  seller: EtaxParty;
  buyer?: EtaxParty | null;
  subtotal: number;
  discount?: number;
  vat_rate: number;
  vat_amount: number;
  grand_total: number;
  lines: EtaxLine[];
  notes?: string | null;
}

const VAT = 'VAT';
const TYPE_CODE = '388'; // UN/EDIFACT 1001 — 388 = TAX INVOICE

function party(tag: string, p: EtaxParty): string {
  const branch = p.branch_code && p.branch_code.trim() ? p.branch_code : '00000';
  return [
    `  <cac:${tag}>`,
    `    <cac:Party>`,
    p.tax_id ? `      <cac:PartyIdentification><cbc:ID schemeID="TXID">${esc(p.tax_id)}</cbc:ID></cac:PartyIdentification>` : '',
    `      <cac:PartyName><cbc:Name>${esc(p.name)}</cbc:Name></cac:PartyName>`,
    `      <cac:PostalAddress><cbc:Line>${esc(p.address)}</cbc:Line><cac:Country><cbc:IdentificationCode>TH</cbc:IdentificationCode></cac:Country></cac:PostalAddress>`,
    p.tax_id ? `      <cac:PartyTaxScheme><cbc:CompanyID>${esc(p.tax_id)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>${VAT}</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>` : '',
    `      <cac:PartyLegalEntity><cbc:RegistrationName>${esc(p.name)}</cbc:RegistrationName>${p.tax_id ? `<cbc:CompanyID schemeID="TXID">${esc(p.tax_id)}</cbc:CompanyID>` : ''}<cac:RegistrationAddress><cbc:CitySubdivisionName>${esc(branch)}</cbc:CitySubdivisionName></cac:RegistrationAddress></cac:PartyLegalEntity>`,
    `    </cac:Party>`,
    `  </cac:${tag}>`,
  ].filter(Boolean).join('\n');
}

export function buildEtaxInvoiceXml(inv: EtaxInvoice, opts?: { issueTime?: string }): string {
  const cur = inv.currency || 'THB';
  const a = (v: unknown) => amt(v);
  const pct = (Math.round((Number(inv.vat_rate) || 0) * 10000) / 100).toFixed(2); // 0.07 → "7.00"
  const time = opts?.issueTime ?? '00:00:00';

  const lines = inv.lines
    .map((l) =>
      [
        `  <cac:InvoiceLine>`,
        `    <cbc:ID>${esc(l.line_no)}</cbc:ID>`,
        `    <cbc:InvoicedQuantity unitCode="${esc(l.uom || 'EA')}">${l.qty != null ? a(l.qty) : '1.00'}</cbc:InvoicedQuantity>`,
        `    <cbc:LineExtensionAmount currencyID="${cur}">${a(l.amount)}</cbc:LineExtensionAmount>`,
        `    <cac:Item><cbc:Description>${esc(l.description)}</cbc:Description><cbc:Name>${esc(l.description)}</cbc:Name></cac:Item>`,
        l.unit_price != null ? `    <cac:Price><cbc:PriceAmount currencyID="${cur}">${a(l.unit_price)}</cbc:PriceAmount></cac:Price>` : '',
        `  </cac:InvoiceLine>`,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n');

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">`,
    `  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>`,
    `  <cbc:CustomizationID>ETDA-eTaxInvoice-2.0</cbc:CustomizationID>`,
    `  <cbc:ID>${esc(inv.doc_no)}</cbc:ID>`,
    `  <cbc:IssueDate>${esc(inv.issue_date)}</cbc:IssueDate>`,
    `  <cbc:IssueTime>${esc(time)}</cbc:IssueTime>`,
    `  <cbc:InvoiceTypeCode listAgencyID="UN" listID="UNCL1001" name="${inv.type === 'abbreviated' ? 'ใบกำกับภาษีอย่างย่อ' : 'ใบกำกับภาษี'}">${TYPE_CODE}</cbc:InvoiceTypeCode>`,
    inv.notes ? `  <cbc:Note>${esc(inv.notes)}</cbc:Note>` : '',
    `  <cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>`,
    party('AccountingSupplierParty', inv.seller),
    party('AccountingCustomerParty', inv.buyer ?? { name: 'ผู้ซื้อสินค้า/ผู้รับบริการ' }),
    `  <cac:TaxTotal>`,
    `    <cbc:TaxAmount currencyID="${cur}">${a(inv.vat_amount)}</cbc:TaxAmount>`,
    `    <cac:TaxSubtotal>`,
    `      <cbc:TaxableAmount currencyID="${cur}">${a(inv.subtotal)}</cbc:TaxableAmount>`,
    `      <cbc:TaxAmount currencyID="${cur}">${a(inv.vat_amount)}</cbc:TaxAmount>`,
    `      <cac:TaxCategory><cbc:Percent>${pct}</cbc:Percent><cac:TaxScheme><cbc:ID>${VAT}</cbc:ID></cac:TaxScheme></cac:TaxCategory>`,
    `    </cac:TaxSubtotal>`,
    `  </cac:TaxTotal>`,
    `  <cac:LegalMonetaryTotal>`,
    `    <cbc:LineExtensionAmount currencyID="${cur}">${a(inv.subtotal)}</cbc:LineExtensionAmount>`,
    `    <cbc:TaxExclusiveAmount currencyID="${cur}">${a(inv.subtotal)}</cbc:TaxExclusiveAmount>`,
    `    <cbc:TaxInclusiveAmount currencyID="${cur}">${a(inv.grand_total)}</cbc:TaxInclusiveAmount>`,
    `    <cbc:PayableAmount currencyID="${cur}">${a(inv.grand_total)}</cbc:PayableAmount>`,
    `  </cac:LegalMonetaryTotal>`,
    lines,
    `</Invoice>`,
  ]
    .filter(Boolean)
    .join('\n');
}
