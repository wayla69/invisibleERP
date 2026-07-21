import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { desc, eq, and } from 'drizzle-orm';
import { DRIZZLE, runGlobalDb, type DrizzleDb } from '../../database/database.module';
import { saasReceipts, tenants } from '../../database/schema';
import { wrapA4, sellerHeaderHtml, esc, fmtMoney, thaiDate, formatTaxId, type DocParty } from '../../common/doc-html';
import { bahtText } from '../../common/bahttext.util';
import { logger } from '../../observability/logger';
import { PdfRenderer } from '../pdf/pdf-renderer.service';
import { MailerService } from '../mailer/mailer.service';

// ── A4: own-SaaS receipts ───────────────────────────────────────────────────────────────────────────────
// The PLATFORM's receipt paper trail for subscription money it collects — one row per Stripe
// invoice.paid (webhook) or god-recorded bank transfer, numbered RCPT-S-<id>, with a 7% VAT breakdown
// when the issuer is VAT-registered (RECEIPT_ISSUER_TAX_ID set; without it the document stays a plain
// ใบเสร็จรับเงิน and never claims to be a tax invoice). Idempotent on source_ref: a re-delivered webhook
// or a retried manual record converges to ONE receipt. The customer gets a saas_receipt email (A1
// outbox) and can list/download from /billing — reads are hard-scoped to the caller's own tenant.

const issuerParty = (): DocParty => ({
  name: process.env.RECEIPT_ISSUER_NAME ?? 'Invisible ERP',
  tax_id: process.env.RECEIPT_ISSUER_TAX_ID ?? null,
  address: process.env.RECEIPT_ISSUER_ADDRESS ?? null,
});
const vatRate = (): number => {
  const r = Number(process.env.RECEIPT_VAT_RATE ?? 7);
  return Number.isFinite(r) && r > 0 ? r : 7;
};

export interface RecordReceiptOpts {
  tenantId: number;
  source: 'stripe_invoice' | 'manual';
  sourceRef?: string; // required for stripe_invoice; manual defaults to MANUAL-<uuid>
  amount: number; // VAT-inclusive THB
  period?: string | null; // YYYY-MM
  note?: string | null;
  createdBy: string;
}

@Injectable()
export class SaasReceiptsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    @Optional() private readonly pdf?: PdfRenderer,
    @Optional() private readonly mailer?: MailerService,
  ) {}

  /** Record a collected payment (idempotent on source_ref) + email the receipt notice. Cross-tenant by
   *  nature (webhook/god callers) → global-db scope; every row is pinned to about_tenant_id. */
  async record(opts: RecordReceiptOpts) {
    return runGlobalDb('saas-receipts:record', async () => {
      const sourceRef = opts.sourceRef?.trim() || `MANUAL-${randomUUID()}`;
      const amount = Math.round(Number(opts.amount) * 100) / 100;
      const rate = vatRate();
      const vatRegistered = !!(process.env.RECEIPT_ISSUER_TAX_ID ?? '').trim();
      const vat = vatRegistered ? Math.round((amount * rate / (100 + rate)) * 100) / 100 : null;
      const inserted = await this.db.insert(saasReceipts).values({
        receiptNo: `RCPT-S#${sourceRef}`.slice(0, 60), // placeholder; finalized from the serial id below
        aboutTenantId: opts.tenantId, source: opts.source, sourceRef,
        period: opts.period ?? null, amount: String(amount), vatAmount: vat != null ? String(vat) : null,
        note: opts.note ?? null, createdBy: opts.createdBy,
      }).onConflictDoNothing({ target: saasReceipts.sourceRef }).returning({ id: saasReceipts.id });
      if (!inserted.length) {
        const [existing] = await this.db.select().from(saasReceipts).where(eq(saasReceipts.sourceRef, sourceRef)).limit(1);
        return { receipt_no: existing!.receiptNo, id: Number(existing!.id), created: false };
      }
      const id = Number(inserted[0]!.id);
      const receiptNo = `RCPT-S-${String(id).padStart(6, '0')}`;
      await this.db.update(saasReceipts).set({ receiptNo }).where(eq(saasReceipts.id, id));
      const [tenant] = await this.db.select({ name: tenants.name, email: tenants.email }).from(tenants).where(eq(tenants.id, opts.tenantId)).limit(1);
      if (tenant?.email) {
        await this.mailer?.send({
          template: 'saas_receipt', to: tenant.email, aboutTenantId: opts.tenantId,
          vars: {
            company: tenant.name, receipt_no: receiptNo, amount: fmtMoney(amount),
            period: opts.period ?? '', billing_url: `${(process.env.APP_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '')}/billing`,
          },
        }).catch((e) => logger.warn({ receipt_no: receiptNo, err: (e as Error)?.message }, 'saas_receipt email enqueue failed'));
      }
      logger.info({ receipt_no: receiptNo, tenant_id: opts.tenantId, amount, source: opts.source }, 'saas receipt recorded');
      return { receipt_no: receiptNo, id, created: true };
    });
  }

  /** A tenant's own receipts (BOLA-safe: explicit about_tenant_id filter — never caller-supplied ids). */
  async listForTenant(tenantId: number, limit = 100) {
    const rows = await this.db.select().from(saasReceipts)
      .where(eq(saasReceipts.aboutTenantId, tenantId))
      .orderBy(desc(saasReceipts.id)).limit(Math.min(Math.max(limit, 1), 200));
    return { receipts: rows.map((r) => this.toJson(r)) };
  }

  /** One receipt scoped to a tenant (tenantId null = god). 404 on other tenants' numbers — never 403. */
  async getScoped(receiptNo: string, tenantId: number | null) {
    const where = tenantId == null
      ? eq(saasReceipts.receiptNo, receiptNo)
      : and(eq(saasReceipts.receiptNo, receiptNo), eq(saasReceipts.aboutTenantId, tenantId));
    const [row] = await this.db.select().from(saasReceipts).where(where).limit(1);
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Receipt not found', messageTh: 'ไม่พบใบเสร็จ' });
    return row;
  }

  /** Bilingual A4 receipt document (ใบเสร็จรับเงิน; + ใบกำกับภาษี label only when VAT-registered). */
  async receiptHtml(receiptNo: string, tenantId: number | null): Promise<string> {
    const r = await this.getScoped(receiptNo, tenantId);
    const [tenant] = await this.db.select({ name: tenants.name, taxId: tenants.taxId }).from(tenants).where(eq(tenants.id, Number(r.aboutTenantId))).limit(1);
    const amount = Number(r.amount);
    const vat = r.vatAmount != null ? Number(r.vatAmount) : null;
    const title = vat != null ? 'ใบเสร็จรับเงิน / ใบกำกับภาษี' : 'ใบเสร็จรับเงิน';
    const vatRows = vat != null
      ? `<tr><td class="tlbl">มูลค่าก่อนภาษีมูลค่าเพิ่ม</td><td class="tval">${fmtMoney(amount - vat)}</td></tr>
         <tr><td class="tlbl">ภาษีมูลค่าเพิ่ม (${vatRate()}%)</td><td class="tval">${fmtMoney(vat)}</td></tr>`
      : '';
    return wrapA4(`
      <div class="hdr">
        ${sellerHeaderHtml(issuerParty())}
        <div class="ttl">${esc(title)}<div class="sub">Subscription Receipt</div></div>
      </div>
      <table class="meta">
        <tr><td class="lbl">ลูกค้า</td><td>${esc(tenant?.name ?? '-')}</td><td class="lbl">เลขที่</td><td>${esc(r.receiptNo)}</td></tr>
        <tr><td class="lbl">เลขประจำตัวผู้เสียภาษีลูกค้า</td><td>${esc(tenant?.taxId ? formatTaxId(tenant.taxId) : '-')}</td><td class="lbl">วันที่</td><td>${esc(thaiDate(r.createdAt as unknown as string))}</td></tr>
        <tr><td class="lbl">รายการ</td><td>ค่าบริการระบบ Invisible ERP${r.period ? ` งวด ${esc(r.period)}` : ''}${r.note ? ` · ${esc(r.note)}` : ''}</td><td class="lbl">อ้างอิง</td><td>${esc(r.sourceRef)}</td></tr>
      </table>
      <table class="totals">
        ${vatRows}
        <tr class="grand"><td class="tlbl">จำนวนเงินรวม (${esc(r.currency)})</td><td class="tval">${fmtMoney(amount)}</td></tr>
      </table>
      ${r.currency === 'THB' ? `<div class="words">( ${esc(bahtText(amount))} )</div>` : ''}
      <div class="foot"><div class="sign">ผู้รับเงิน<div class="who">${esc(r.createdBy)}</div></div></div>
    `, title);
  }

  renderPdf(html: string): Promise<Buffer | null> {
    if (!this.pdf) return Promise.resolve(null);
    return this.pdf.render(html, { format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } });
  }

  private toJson(r: typeof saasReceipts.$inferSelect) {
    return {
      id: Number(r.id), receipt_no: r.receiptNo, source: r.source, source_ref: r.sourceRef,
      period: r.period, amount: Number(r.amount), vat_amount: r.vatAmount != null ? Number(r.vatAmount) : null,
      currency: r.currency, note: r.note, created_by: r.createdBy, created_at: r.createdAt,
    };
  }
}
