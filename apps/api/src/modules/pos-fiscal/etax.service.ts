import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { etaxSubmissions, taxInvoices, taxInvoiceLines } from '../../database/schema';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { buildEtaxInvoiceXml, type EtaxInvoice } from '../tax-docs/etax-xml';
import { getSigningMaterial, signEtaxXml } from '../tax-docs/etax-sign';

// RD/ETDA e-Tax Invoice & e-Receipt submission via a service provider.
//   • The UBL 2.1 XML (etax-xml) is built from the stored tax invoice, then XAdES-signed when a
//     certificate is configured (ETAX_SIGNING_* — see etax-sign.getSigningMaterial); otherwise the
//     unsigned instance document is submitted (sandbox/by-email path).
//   • 'mock' acks immediately (CI + when no SP is configured). 'http' POSTs the (signed) XML to a
//     generic SP endpoint (ETAX_PROVIDER_URL/_TOKEN) — drop-in for INET/Frank/Leceipt once creds exist.
@Injectable()
export class EtaxService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // Build the e-Tax UBL DTO straight from the stored tax invoice (no cross-module DI → no cycle).
  private async invoiceDto(docNo: string): Promise<EtaxInvoice> {
    const db = this.db as any;
    const [h] = await db.select().from(taxInvoices).where(eq(taxInvoices.docNo, docNo)).limit(1);
    if (!h) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Tax invoice not found', messageTh: 'ไม่พบใบกำกับภาษี' });
    const lines = await db.select().from(taxInvoiceLines).where(eq(taxInvoiceLines.taxInvoiceId, Number(h.id))).orderBy(taxInvoiceLines.lineNo);
    return {
      doc_no: h.docNo, type: h.type, issue_date: h.issueDate, currency: h.currency ?? 'THB',
      seller: { name: h.sellerName, tax_id: h.sellerTaxId, branch_code: h.sellerBranchCode, address: h.sellerAddress },
      buyer: h.buyerName ? { name: h.buyerName, tax_id: h.buyerTaxId, branch_code: h.buyerBranchCode, address: h.buyerAddress } : null,
      subtotal: n(h.subtotal), discount: n(h.discount), vat_rate: n(h.vatRate), vat_amount: n(h.vatAmount), grand_total: n(h.grandTotal),
      notes: h.notes ?? null,
      lines: lines.map((l: any) => ({ line_no: n(l.lineNo), description: l.description, qty: l.qty != null ? n(l.qty) : null, uom: l.uom, unit_price: l.unitPrice != null ? n(l.unitPrice) : null, amount: n(l.amount) })),
    };
  }

  // Build + (optionally) sign the e-Tax document for a stored tax invoice.
  async buildDocument(docNo: string): Promise<{ xml: string; signed: boolean }> {
    const dto = await this.invoiceDto(docNo);
    const xml = buildEtaxInvoiceXml(dto as never);
    const material = getSigningMaterial();
    if (!material) return { xml, signed: false };
    return { xml: signEtaxXml(xml, material), signed: true };
  }

  private async submitToProvider(provider: string, docNo: string, doc: { xml: string; signed: boolean }): Promise<{ status: string; providerRef: string; rd: any }> {
    if (provider === 'mock') {
      return { status: 'Accepted', providerRef: `mock-${docNo}`, rd: { code: '0', message: 'accepted (sandbox)', signed: doc.signed } };
    }
    if (provider === 'http') {
      const url = process.env.ETAX_PROVIDER_URL;
      if (!url) throw new BadRequestException({ code: 'ETAX_PROVIDER_NOT_CONFIGURED', message: 'ETAX_PROVIDER_URL is not set', messageTh: 'ยังไม่ได้ตั้งค่า ETAX_PROVIDER_URL' });
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (process.env.ETAX_PROVIDER_TOKEN) headers[process.env.ETAX_PROVIDER_AUTH_HEADER || 'Authorization'] = `Bearer ${process.env.ETAX_PROVIDER_TOKEN}`;
      const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ doc_no: docNo, signed: doc.signed, xml: doc.xml }) });
      let body: any = {};
      try { body = await resp.json(); } catch { /* non-JSON SP response */ }
      const status = body.status ?? (resp.ok ? 'Accepted' : 'Rejected');
      const providerRef = body.ref ?? body.providerRef ?? body.id ?? `http-${docNo}`;
      return { status, providerRef, rd: { http_status: resp.status, ...body, signed: doc.signed } };
    }
    // INET / Frank / Leceipt etc. would each map onto the generic 'http' shape or a dedicated adapter.
    throw new BadRequestException({ code: 'ETAX_PROVIDER_NOT_CONFIGURED', message: `e-Tax provider ${provider} not configured`, messageTh: 'ยังไม่ได้ตั้งค่าผู้ให้บริการ e-Tax' });
  }

  async submit(docNo: string, provider: string | undefined, user: JwtUser) {
    const db = this.db as any;
    const prov = provider ?? process.env.ETAX_PROVIDER ?? 'mock';
    const [existing] = await db.select().from(etaxSubmissions).where(and(eq(etaxSubmissions.docNo, docNo), eq(etaxSubmissions.status, 'Accepted'))).limit(1);
    if (existing) return { doc_no: docNo, status: 'Accepted', provider_ref: existing.providerRef, idempotent: true };

    const doc = await this.buildDocument(docNo);
    const res = await this.submitToProvider(prov, docNo, doc);
    const xmlDigest = createHash('sha256').update(doc.xml).digest('hex');
    await db.insert(etaxSubmissions).values({
      tenantId: user.tenantId ?? null, docNo, provider: prov, status: res.status, providerRef: res.providerRef,
      rdResponse: { ...res.rd, signed: doc.signed, xml_sha256: xmlDigest }, submittedBy: user.username, submittedAt: new Date(),
    });
    return { doc_no: docNo, status: res.status, provider_ref: res.providerRef, provider: prov, signed: doc.signed };
  }

  async status(docNo: string) {
    const db = this.db as any;
    const [s] = await db.select().from(etaxSubmissions).where(eq(etaxSubmissions.docNo, docNo)).orderBy(desc(etaxSubmissions.id)).limit(1);
    if (!s) return { doc_no: docNo, status: 'NotSubmitted' };
    return { doc_no: docNo, status: s.status, provider: s.provider, provider_ref: s.providerRef, submitted_at: s.submittedAt, rd_response: s.rdResponse };
  }

  async list(limit = 100) {
    const db = this.db as any;
    const rows = await db.select().from(etaxSubmissions).orderBy(desc(etaxSubmissions.id)).limit(limit);
    return { submissions: rows.map((r: any) => ({ doc_no: r.docNo, provider: r.provider, status: r.status, provider_ref: r.providerRef, signed: r.rdResponse?.signed ?? false, submitted_at: r.submittedAt })), count: rows.length };
  }
}
