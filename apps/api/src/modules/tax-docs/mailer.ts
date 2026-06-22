import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import nodemailer from 'nodemailer';

// Pluggable mail transport — abstracted so it can be mocked in tests and swapped per deployment.
export const MAILER = Symbol('MAILER');

export interface MailAttachment { filename: string; content: string | Buffer; contentType?: string }
export interface MailMessage { from: string; to: string; cc?: string; subject: string; text?: string; html?: string; attachments?: MailAttachment[] }
export interface MailResult { messageId: string; accepted: string[] }
export interface Mailer {
  send(msg: MailMessage): Promise<MailResult>;
}

// SMTP transport. Reads SMTP_* env lazily; throws a clear, localized error when SMTP is not configured
// so the feature is complete in code but obviously needs a mail account to actually dispatch.
@Injectable()
export class NodemailerMailer implements Mailer {
  private readonly log = new Logger('Mailer');
  private transport: nodemailer.Transporter | null = null;

  private get tx(): nodemailer.Transporter {
    if (this.transport) return this.transport;
    const host = process.env.SMTP_HOST;
    if (!host)
      throw new ServiceUnavailableException({
        code: 'EMAIL_NOT_CONFIGURED',
        message: 'SMTP is not configured (set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS)',
        messageTh: 'ยังไม่ได้ตั้งค่าอีเมล (SMTP) สำหรับส่งเอกสาร',
      });
    this.transport = nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
    return this.transport;
  }

  async send(msg: MailMessage): Promise<MailResult> {
    const info = await this.tx.sendMail(msg);
    this.log.log(`sent "${msg.subject}" → ${msg.to} (cc ${msg.cc ?? '-'}) id=${info.messageId}`);
    return { messageId: String(info.messageId), accepted: (info.accepted ?? []).map(String) };
  }
}
