import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { MAILER, type Mailer } from '../tax/documents/mailer';
import { PdfRenderer } from '../pdf/pdf-renderer.service';

export interface SendDocumentOptions {
  to: string;                 // recipient (customer/supplier) email
  from?: string;              // sender identity — resolve from the tenant/company profile; falls back to MAIL_FROM
  cc?: string;
  subject: string;
  text?: string;              // plain-text body
  filename: string;          // attachment base name WITHOUT extension (e.g. the doc number)
  html: string;               // the rendered document HTML (the same string the /pdf endpoint serves)
  slip?: boolean;             // 80mm thermal geometry instead of A4
}

export interface SendDocumentResult { sent: true; to: string; via: 'pdf' | 'html'; message_id: string }

// Generic "email this document" service. Any module that already renders a document to HTML can attach it
// to an email in one call: the HTML is rendered to a PDF through the shared PdfRenderer and attached, or —
// when Chromium is unavailable (CI/degraded) — the raw HTML is attached instead (same graceful-degrade
// contract as the /pdf endpoints). Transport is the pluggable MAILER (SMTP via NodemailerMailer), which
// throws EMAIL_NOT_CONFIGURED when SMTP_* is unset, so the feature is complete in code and only needs a
// mail account to dispatch. This is the single reusable outbound-document email path (previously only the
// e-Tax invoice could be emailed).
@Injectable()
export class DocEmailService {
  constructor(@Inject(MAILER) private readonly mailer: Mailer, private readonly pdf: PdfRenderer) {}

  async sendDocument(opts: SendDocumentOptions): Promise<SendDocumentResult> {
    const to = (opts.to ?? '').trim();
    if (!to.includes('@')) {
      throw new BadRequestException({ code: 'NO_RECIPIENT', message: 'A valid recipient email is required', messageTh: 'ต้องระบุอีเมลผู้รับที่ถูกต้อง' });
    }
    const from = (opts.from ?? process.env.MAIL_FROM ?? process.env.SMTP_USER ?? '').trim();
    if (!from.includes('@')) {
      throw new BadRequestException({ code: 'NO_SENDER_EMAIL', message: 'Sender email not set — configure it in the business profile (or MAIL_FROM)', messageTh: 'ยังไม่ได้ตั้งอีเมลผู้ส่งในข้อมูลกิจการ' });
    }
    const buf = await this.pdf.render(opts.html, opts.slip
      ? { width: '80mm', printBackground: true, margin: { top: '4mm', bottom: '4mm', left: '3mm', right: '3mm' } }
      : { format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } });
    const attachment = buf
      ? { filename: `${opts.filename}.pdf`, content: buf, contentType: 'application/pdf' }
      : { filename: `${opts.filename}.html`, content: opts.html, contentType: 'text/html; charset=utf-8' };
    const res = await this.mailer.send({ from, to, cc: opts.cc, subject: opts.subject, text: opts.text, attachments: [attachment] });
    return { sent: true, to, via: buf ? 'pdf' : 'html', message_id: res.messageId };
  }
}
