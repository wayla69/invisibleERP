import { Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { eq, and, desc, asc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { printJobs } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';
import { ReceiptService } from './receipt.service';
import { MessagingService } from '../messaging/messaging.service';

type EnqueueDto = { job_type: 'receipt' | 'kitchen' | 'drawer'; sale_no?: string; order_no?: string; station?: string; format?: 'escpos' | 'html'; printer_id?: string; payload?: string; lang?: 'th' | 'en' | 'both' };

// Print-job queue: receipts (and kitchen tickets) are rendered server-side and queued; a CloudPRNT printer
// or local agent pulls the next job for its tenant (and optional printer id), prints it, then acks. Also
// delivers receipts out-of-band (email / LINE / SMS) via the messaging gateway.
@Injectable()
export class PrintService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly receipts: ReceiptService,
    private readonly messaging: MessagingService,
  ) {}

  // Enqueue a job. For a receipt with no explicit payload, render it from the sale now (so the queued bytes
  // are a stable snapshot). A second+ receipt job for the same sale is flagged as a COPY (สำเนา).
  async enqueue(dto: EnqueueDto, user: JwtUser, opts?: { taxInvoiceNo?: string | null; lang?: 'th' | 'en' | 'both' }) {
    const db = this.db;
    const format = dto.format ?? 'escpos';
    let payload = dto.payload ?? '';
    if (dto.job_type === 'receipt') {
      if (!dto.sale_no) throw new BadRequestException({ code: 'NO_SALE_NO', message: 'sale_no required', messageTh: 'ต้องระบุเลขที่ขาย' });
      const prior = await db.select({ id: printJobs.id }).from(printJobs).where(and(eq(printJobs.saleNo, dto.sale_no), eq(printJobs.jobType, 'receipt'))).limit(1);
      const d = await this.receipts.loadData(dto.sale_no, { isCopy: prior.length > 0, taxInvoiceNo: opts?.taxInvoiceNo, lang: dto.lang ?? opts?.lang });
      payload = format === 'html' ? this.receipts.html(d) : this.receipts.escpos(d);
    }
    if (!payload) throw new BadRequestException({ code: 'NO_PAYLOAD', message: 'payload required', messageTh: 'ไม่มีเนื้อหาสำหรับพิมพ์' });
    // ESC/POS carries NUL/control bytes that a Postgres text column can't store — base64 the bytes; the
    // pulling agent decodes them back to raw ESC/POS. HTML is plain UTF-8 and stored as-is.
    if (format === 'escpos') payload = Buffer.from(payload, 'latin1').toString('base64');
    const [r] = await db.insert(printJobs).values({
      tenantId: user.tenantId ?? null, branchId: (user as any).branchId ?? null, jobType: dto.job_type,
      station: dto.station ?? null, saleNo: dto.sale_no ?? null, orderNo: dto.order_no ?? null,
      format, payload, printerId: dto.printer_id ?? null, status: 'queued', createdBy: user.username,
    }).returning({ id: printJobs.id });
    return { id: Number(r!.id), job_type: dto.job_type, status: 'queued', format };
  }

  // Agent pull: claim the oldest queued job for this tenant (and printer, if the agent declares one).
  async nextJob(user: JwtUser, printerId?: string): Promise<{ job: null | { id: number; job_type: string; station: string | null; sale_no: string | null; order_no: string | null; format: string; payload: string; printer_id: string | null } }> {
    const db = this.db;
    const where = printerId
      ? and(eq(printJobs.status, 'queued'), sql`(${printJobs.printerId} IS NULL OR ${printJobs.printerId} = ${printerId})`)
      : eq(printJobs.status, 'queued');
    const [job] = await db.select().from(printJobs).where(where).orderBy(asc(printJobs.id)).limit(1);
    if (!job) return { job: null };
    // claim it (guard on status so two agents don't double-claim the same row)
    const claimed = await db.update(printJobs).set({ status: 'sent', attempts: sql`${printJobs.attempts} + 1` })
      .where(and(eq(printJobs.id, job.id), eq(printJobs.status, 'queued'))).returning({ id: printJobs.id });
    if (!claimed.length) return this.nextJob(user, printerId); // lost the race → try the next one
    return { job: { id: Number(job.id), job_type: job.jobType, station: job.station, sale_no: job.saleNo, order_no: job.orderNo, format: job.format, payload: job.payload, printer_id: job.printerId } };
  }

  // Agent ack: mark printed (or failed with an error → re-queued for retry up to 5 attempts).
  async ack(id: number, ok: boolean, error: string | undefined, _user: JwtUser) {
    const db = this.db;
    const [job] = await db.select().from(printJobs).where(eq(printJobs.id, id)).limit(1);
    if (!job) throw new NotFoundException({ code: 'JOB_NOT_FOUND', message: 'Job not found', messageTh: 'ไม่พบงานพิมพ์' });
    if (ok) {
      await db.update(printJobs).set({ status: 'printed', printedAt: new Date(), error: null }).where(eq(printJobs.id, id));
      return { id, status: 'printed' };
    }
    const status = Number(job.attempts) >= 5 ? 'failed' : 'queued'; // retry until 5 attempts, then give up
    await db.update(printJobs).set({ status, error: error ?? 'print failed' }).where(eq(printJobs.id, id));
    return { id, status };
  }

  // Reprint a receipt → enqueues a fresh job; flagged as a COPY because the original already exists.
  async reprint(saleNo: string, user: JwtUser, format?: 'escpos' | 'html', lang?: 'th' | 'en' | 'both') {
    return this.enqueue({ job_type: 'receipt', sale_no: saleNo, format, lang }, user);
  }

  // Deliver a receipt out-of-band (email / LINE / SMS) via the messaging gateway. Text receipt only.
  async sendReceipt(saleNo: string, channel: 'line' | 'sms' | 'email', to: string, user: JwtUser) {
    const d = await this.receipts.loadData(saleNo, { isCopy: true });
    const lines = d.items.map((l) => `${l.qty}x ${l.description}  ${l.amount.toFixed(2)}`).join('\n');
    const body = `${d.seller.legal_name || d.seller.name}\nใบเสร็จ ${d.sale_no} (${d.date ?? ''})\n${lines}\nรวมสุทธิ ${d.total.toFixed(2)} บาท\nขอบคุณที่ใช้บริการ`;
    const res = await this.messaging.send({ to, channel, body, campaign: 'receipt' }, user);
    return { sale_no: saleNo, channel, ...res };
  }

  async list(_user: JwtUser, status?: string, limit = 50) {
    const db = this.db;
    const where = status ? eq(printJobs.status, status) : undefined;
    const rows = await (where ? db.select().from(printJobs).where(where) : db.select().from(printJobs)).orderBy(desc(printJobs.id)).limit(limit);
    return { jobs: rows.map((r: any) => ({ id: Number(r.id), job_type: r.jobType, station: r.station, sale_no: r.saleNo, order_no: r.orderNo, format: r.format, status: r.status, attempts: r.attempts, error: r.error, created_at: r.createdAt, printed_at: r.printedAt })) };
  }

  // Receipt previews (no queue) — used by the web printable page and the tie-out control.
  async preview(saleNo: string, format: 'html' | 'data', user: JwtUser, lang?: 'th' | 'en' | 'both') {
    const prior = await this.db.select({ id: printJobs.id }).from(printJobs).where(and(eq(printJobs.saleNo, saleNo), eq(printJobs.jobType, 'receipt'))).limit(1);
    const d = await this.receipts.loadData(saleNo, { isCopy: prior.length > 0, lang });
    return format === 'html' ? { html: this.receipts.html(d) } : { data: d, tie_out: this.receipts.tieOut(d) };
  }

  async tieOut(saleNo: string, _user: JwtUser) {
    const d = await this.receipts.loadData(saleNo);
    return this.receipts.tieOut(d);
  }
}
