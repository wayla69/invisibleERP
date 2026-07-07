import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, ne, desc } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DRIZZLE, PG_CLIENT, type DrizzleDb, type PgClient } from '../../../database/database.module';
import { etaxSubmissions, taxInvoices, taxInvoiceLines } from '../../../database/schema';
import { n } from '../../../database/queries';
import type { JwtUser } from '../../../common/decorators';
import { buildEtaxInvoiceXml, type EtaxInvoice } from '../../tax/documents/etax-xml';
import { getSigningMaterial, signEtaxXml } from '../../tax/documents/etax-sign';
import { captureOpsAlert } from '../../../observability/instrumentation';

// RD/ETDA e-Tax Invoice & e-Receipt submission via a service provider.
//   • The UBL 2.1 XML (etax-xml) is built from the stored tax invoice, then XAdES-signed when a
//     certificate is configured (ETAX_SIGNING_* — see etax-sign.getSigningMaterial); otherwise the
//     unsigned instance document is submitted (sandbox/by-email path).
//   • 'mock' acks immediately (CI + when no SP is configured). 'http' POSTs the (signed) XML to a
//     generic SP endpoint (ETAX_PROVIDER_URL/_TOKEN) — drop-in for INET/Frank/Leceipt once creds exist.
@Injectable()
export class EtaxService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    // Every non-SSE request runs inside ONE transaction (TenantTxInterceptor) that rolls back on any thrown
    // exception — so a failure row written via `db` INSIDE the same request that then rethrows (the direct
    // POST /api/tax/etax/submit/:docNo path) would itself be rolled back, recreating the exact silent-loss bug
    // this is meant to fix. Write the failure row on the AUTOCOMMIT raw client instead (same pattern as
    // login_attempts / ai_token_usage) so it survives the enclosing rollback.
    @Inject(PG_CLIENT) private readonly rawSql: PgClient,
  ) {}

  // Build the e-Tax UBL DTO straight from the stored tax invoice (no cross-module DI → no cycle).
  private async invoiceDto(docNo: string): Promise<EtaxInvoice> {
    const db = this.db;
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

  // Submission durability: EVERY attempt is persisted — success, an explicit SP rejection, or a thrown
  // error (SP unreachable, ETAX_PROVIDER_URL not configured, etc). Previously a thrown error escaped
  // BEFORE any row was written, so a failed submission left no trace at all — a silent, undelivered legal
  // document. Now a failure is recorded as status='Rejected' with the error in rd_response.error BEFORE
  // the exception is rethrown, so it is visible (GET /api/tax/etax) and retryable (retryFailed below).
  async submit(docNo: string, provider: string | undefined, user: JwtUser) {
    const db = this.db;
    const prov = provider ?? process.env.ETAX_PROVIDER ?? 'mock';
    const [existing] = await db.select().from(etaxSubmissions).where(and(eq(etaxSubmissions.docNo, docNo), eq(etaxSubmissions.status, 'Accepted'))).limit(1);
    if (existing) return { doc_no: docNo, status: 'Accepted', provider_ref: existing.providerRef, idempotent: true };

    const doc = await this.buildDocument(docNo);

    let res: { status: string; providerRef: string; rd: any };
    try {
      res = await this.submitToProvider(prov, docNo, doc);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // AUTOCOMMIT write (see constructor note) — must survive this request's transaction rolling back
      // once `e` is rethrown below. Its own failure (raw connection down) must not replace the REAL error
      // with an opaque 500 — log it as a separate, distinct alert and still surface the original `e`.
      try {
        await this.rawSql`
          INSERT INTO etax_submissions (tenant_id, doc_no, provider, status, provider_ref, rd_response, submitted_by, submitted_at)
          VALUES (${user.tenantId ?? null}, ${docNo}, ${prov}, 'Rejected', NULL, ${JSON.stringify({ error: message, signed: doc.signed })}::jsonb, ${user.username}, now())`;
      } catch (writeErr) {
        captureOpsAlert('etax_submit_failure_not_recorded', { doc_no: docNo, provider: prov, degraded: 'e-Tax submission failed AND the failure-audit write itself failed — this attempt is untracked' }, writeErr);
      }
      captureOpsAlert('etax_submit_failed', { doc_no: docNo, provider: prov, degraded: 'e-Tax submission failed but was recorded for retry (GET /api/tax/etax, or the etax_submission_retry BI job)' }, e);
      throw e;
    }

    const xmlDigest = createHash('sha256').update(doc.xml).digest('hex');
    await db.insert(etaxSubmissions).values({
      tenantId: user.tenantId ?? null, docNo, provider: prov, status: res.status, providerRef: res.providerRef,
      rdResponse: { ...res.rd, signed: doc.signed, xml_sha256: xmlDigest }, submittedBy: user.username, submittedAt: new Date(),
    });
    return { doc_no: docNo, status: res.status, provider_ref: res.providerRef, provider: prov, signed: doc.signed };
  }

  async status(docNo: string) {
    const db = this.db;
    const [s] = await db.select().from(etaxSubmissions).where(eq(etaxSubmissions.docNo, docNo)).orderBy(desc(etaxSubmissions.id)).limit(1);
    if (!s) return { doc_no: docNo, status: 'NotSubmitted' };
    return { doc_no: docNo, status: s.status, provider: s.provider, provider_ref: s.providerRef, submitted_at: s.submittedAt, rd_response: s.rdResponse };
  }

  async list(limit = 100, status?: string) {
    const db = this.db;
    const conds = status ? [eq(etaxSubmissions.status, status)] : [];
    const rows = await db.select().from(etaxSubmissions).where(conds.length ? and(...conds) : undefined).orderBy(desc(etaxSubmissions.id)).limit(limit);
    return { submissions: rows.map((r: any) => ({ doc_no: r.docNo, provider: r.provider, status: r.status, provider_ref: r.providerRef, signed: r.rdResponse?.signed ?? false, error: r.status !== 'Accepted' ? (r.rdResponse?.error ?? r.rdResponse?.message ?? null) : null, submitted_at: r.submittedAt })), count: rows.length };
  }

  // Idempotent retry sweep (rides the BI report scheduler, see TaxJobsService.runEtaxSubmissionRetry) —
  // gap #5 in docs/ops/etax-production-spike.md ("submission durability"). Each docNo may have several
  // attempt rows over time (submit() always inserts, never updates); the LATEST row per docNo is
  // authoritative (same convention as status() above). Retries every doc whose latest attempt isn't
  // Accepted yet — a fresh success or failure lands as ANOTHER new row via the normal submit() path.
  async retryFailed(user: JwtUser, limit = 200) {
    const db = this.db;
    const rows = await db.select().from(etaxSubmissions).where(ne(etaxSubmissions.status, 'Accepted')).orderBy(desc(etaxSubmissions.id)).limit(2000);
    const latestByDoc = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!latestByDoc.has(r.docNo)) latestByDoc.set(r.docNo, r);
    const toRetry = [...latestByDoc.values()].filter((r) => r.status !== 'Accepted').slice(0, limit);

    const results: { doc_no: string; status: string }[] = [];
    for (const row of toRetry) {
      try {
        const res = await this.submit(row.docNo, row.provider ?? undefined, user);
        results.push({ doc_no: row.docNo, status: res.status });
      } catch {
        results.push({ doc_no: row.docNo, status: 'Rejected' }); // submit() already recorded the failed attempt
      }
    }
    const succeeded = results.filter((r) => r.status === 'Accepted').length;
    return { scanned: toRetry.length, succeeded, failed: toRetry.length - succeeded, results };
  }
}
