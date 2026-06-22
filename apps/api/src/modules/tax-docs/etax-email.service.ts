import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { taxInvoices, tenants } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { TaxInvoiceService } from './tax-invoice.service';
import { buildEtaxInvoiceXml, type EtaxInvoice } from './etax-xml';
import { MAILER, type Mailer, type MailMessage } from './mailer';

// ETDA "e-Tax Invoice by Email" — for businesses with income ≤ 30M THB/yr; NO digital certificate (CA).
// The seller emails the invoice to the buyer with a CC to ETDA's time-stamp mailbox, which stamps the
// document and returns it. Integrity/non-repudiation comes from the ETDA time stamp, not a CA signature.
export const ETAX_TIMESTAMP_EMAIL = process.env.ETAX_TIMESTAMP_EMAIL || 'csemail@etda.or.th';

export interface EtaxEmailResult { sent: boolean; to: string; cc: string; message_id: string; doc_no: string }

@Injectable()
export class EtaxEmailService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly invoices: TaxInvoiceService,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  // Build the message (no send) — pure + unit-testable. CC always goes to the ETDA time-stamp mailbox.
  compose(inv: EtaxInvoice, sellerEmail: string, toEmail: string): MailMessage {
    const xml = buildEtaxInvoiceXml(inv);
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
      attachments: [{ filename: `${inv.doc_no}.xml`, content: xml, contentType: 'application/xml' }],
    };
  }

  async sendByEmail(user: JwtUser, docNo: string, toEmail: string): Promise<EtaxEmailResult> {
    if (!toEmail || !toEmail.includes('@'))
      throw new BadRequestException({ code: 'NO_RECIPIENT', message: 'Valid buyer email required', messageTh: 'ต้องระบุอีเมลผู้ซื้อที่ถูกต้อง' });
    const inv = await this.invoices.getByDocNo(user, docNo);

    // seller email lives on the tenant (issuer) row — resolve via the invoice's own seller tenant.
    const db = this.db as any;
    const [head] = await db.select({ tid: taxInvoices.tenantId }).from(taxInvoices).where(eq(taxInvoices.docNo, docNo)).limit(1);
    const [t] = head ? await db.select({ email: tenants.email }).from(tenants).where(eq(tenants.id, head.tid)).limit(1) : [null];
    const sellerEmail = t?.email as string | undefined;
    if (!sellerEmail)
      throw new BadRequestException({ code: 'NO_SELLER_EMAIL', message: 'Seller email not set — configure it in the business profile', messageTh: 'ยังไม่ได้ตั้งอีเมลผู้ขายในข้อมูลกิจการ (ตั้งค่ากิจการ)' });

    const msg = this.compose(inv as unknown as EtaxInvoice, sellerEmail, toEmail);
    const res = await this.mailer.send(msg);
    return { sent: true, to: toEmail, cc: msg.cc as string, message_id: res.messageId, doc_no: docNo };
  }
}
