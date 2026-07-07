import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { taxInvoices, tenants } from '../../../database/schema';
import type { JwtUser } from '../../../common/decorators';
import { TaxInvoiceService } from './tax-invoice.service';
import { type EtaxInvoice } from './etax-xml';
import { TaxDocsPdfService } from './tax-docs-pdf.service';
import { normalizeA4Template } from '../../../common/a4-template';
import { MAILER, type Mailer, type MailMessage, type MailAttachment } from './mailer';

// ETDA "e-Tax Invoice by Email" — for businesses with income ≤ 30M THB/yr; NO digital certificate (CA).
// The seller emails the invoice to the buyer with a CC to ETDA's time-stamp mailbox, which time-stamps the
// document and returns it. Integrity/non-repudiation comes from the ETDA time stamp, not a CA signature.
//
// The attached document MUST be the readable PDF (a plain UBL XML attachment cannot be opened by the buyer,
// and ETDA's time-stamp service — and its public validator at validation.teda.th — operates on the PDF, not
// an XML instance document; that XML/CA-signature path is the SEPARATE "e-Tax Invoice & e-Receipt" scheme,
// see etax-sign.ts/etaxXml() on the controller).
export const ETAX_TIMESTAMP_EMAIL = process.env.ETAX_TIMESTAMP_EMAIL || 'csemail@etda.or.th';

export interface EtaxEmailResult { sent: boolean; to: string; cc: string; message_id: string; doc_no: string }

@Injectable()
export class EtaxEmailService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly invoices: TaxInvoiceService,
    private readonly pdf: TaxDocsPdfService,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  // Render the tax document PDF for the invoice's own type (full / abbreviated / credit-debit note) — mirrors
  // TaxDocsController.pdfDoc so the emailed attachment is identical to the one a user would download.
  private async renderPdfAttachment(inv: any): Promise<MailAttachment> {
    const cfg = normalizeA4Template({}, { fiscal: true });
    const html = inv.type === 'abbreviated' ? this.pdf.abbreviatedTaxInvoiceHtml(inv, cfg)
      : (inv.type === 'credit_note' || inv.type === 'debit_note') ? this.pdf.creditDebitNoteHtml(inv)
      : this.pdf.fullTaxInvoiceHtml(inv, false, cfg);
    const buf = await this.pdf.renderToPdf(html, inv.type === 'abbreviated');
    // Graceful degrade (same as the download endpoint): if the PDF renderer is unavailable, attach the HTML
    // instead of failing the whole send — still a readable document, just not paginated as a PDF.
    return buf
      ? { filename: `${inv.doc_no}.pdf`, content: buf, contentType: 'application/pdf' }
      : { filename: `${inv.doc_no}.html`, content: html, contentType: 'text/html; charset=utf-8' };
  }

  // Build the message (no send). CC always goes to the ETDA time-stamp mailbox.
  async compose(inv: EtaxInvoice, sellerEmail: string, toEmail: string): Promise<MailMessage> {
    const subject = `[e-Tax Invoice] ${inv.doc_no} จาก ${inv.seller?.name ?? ''}`.trim();
    const text = [
      `เรียน ${inv.buyer?.name ?? 'ลูกค้า'},`,
      ``,
      `แนบใบกำกับภาษีอิเล็กทรอนิกส์เลขที่ ${inv.doc_no} ลงวันที่ ${inv.issue_date}`,
      `มูลค่าสินค้า/บริการ ${inv.subtotal} + ภาษีมูลค่าเพิ่ม ${inv.vat_amount} = รวม ${inv.grand_total} ${inv.currency || 'THB'}`,
      ``,
      `อีเมลฉบับนี้ส่งสำเนา (CC) ถึงระบบประทับรับรองเวลาของ ETDA เพื่อรับรองความถูกต้องตามระบบ e-Tax Invoice by Email`,
      ``,
      `${inv.seller?.name ?? ''}`,
    ].join('\n');
    return {
      from: sellerEmail,
      to: toEmail,
      cc: ETAX_TIMESTAMP_EMAIL,
      subject,
      text,
      attachments: [await this.renderPdfAttachment(inv)],
    };
  }

  async sendByEmail(user: JwtUser, docNo: string, toEmail: string): Promise<EtaxEmailResult> {
    if (!toEmail || !toEmail.includes('@'))
      throw new BadRequestException({ code: 'NO_RECIPIENT', message: 'Valid buyer email required', messageTh: 'ต้องระบุอีเมลผู้ซื้อที่ถูกต้อง' });
    const inv = await this.invoices.getByDocNo(user, docNo);

    // seller email lives on the tenant (issuer) row — resolve via the invoice's own seller tenant.
    const db = this.db;
    const [head] = await db.select({ tid: taxInvoices.tenantId }).from(taxInvoices).where(eq(taxInvoices.docNo, docNo)).limit(1);
    const [t] = head ? await db.select({ email: tenants.email }).from(tenants).where(eq(tenants.id, head.tid)).limit(1) : [null];
    const sellerEmail = t?.email as string | undefined;
    if (!sellerEmail)
      throw new BadRequestException({ code: 'NO_SELLER_EMAIL', message: 'Seller email not set — configure it in the business profile', messageTh: 'ยังไม่ได้ตั้งอีเมลผู้ขายในข้อมูลกิจการ (ตั้งค่ากิจการ)' });

    const msg = await this.compose(inv as unknown as EtaxInvoice, sellerEmail, toEmail);
    const res = await this.mailer.send(msg);
    return { sent: true, to: toEmail, cc: msg.cc as string, message_id: res.messageId, doc_no: docNo };
  }
}
