import { Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { sql, eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { payments, paymentRefunds, tillSessions } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { n, fx } from '../../database/queries';
import { round2 } from '../tax/money';
import type { JwtUser } from '../../common/decorators';
import { resolveGateway } from './gateways';

export interface RecordTenderDto {
  sale_no: string;
  tenant_id?: number;
  method: string;
  amount: number;
  currency?: string;
  gateway?: string;
  till_session_id?: number;
}
export interface RefundDto { payment_no: string; amount: number; reason?: string }
export interface OpenTillDto { opening_float?: number }
export interface CloseTillDto { session_no: string; closing_count: number }

@Injectable()
export class PaymentService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
  ) {}

  // POST /api/payments — run a tender against a gateway, persist the result.
  async recordTender(dto: RecordTenderDto, user: JwtUser) {
    const db = this.db as any;
    if (n(dto.amount) <= 0) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Amount must be positive', messageTh: 'จำนวนเงินต้องมากกว่าศูนย์' });
    const currency = dto.currency ?? 'THB';
    const { gateway, name: gatewayName } = resolveGateway(dto.gateway);
    const result = await gateway.authorizeAndCapture(n(dto.amount), currency, dto.method, { sale_no: dto.sale_no });

    const paymentNo = await this.docNo.nextDaily('PAY');
    const now = new Date();
    await db.insert(payments).values({
      paymentNo, saleNo: dto.sale_no, tenantId: dto.tenant_id ?? null, tillSessionId: dto.till_session_id ?? null,
      method: dto.method, amount: fx(dto.amount, 4), currency, gateway: gatewayName, gatewayRef: result.ref,
      status: result.status, createdBy: user.username, capturedAt: result.status === 'Captured' ? now : null,
    });
    return { payment_no: paymentNo, status: result.status, amount: n(dto.amount), gateway_ref: result.ref };
  }

  // POST /api/payments/refunds — refund a captured payment.
  // Guards against over-refund by accumulation: the new refund + all prior refunds must not
  // exceed the captured amount. Only Captured/Settled payments are refundable.
  async refund(dto: RefundDto, user: JwtUser) {
    const db = this.db as any;
    const [pay] = await db.select().from(payments).where(eq(payments.paymentNo, dto.payment_no)).limit(1);
    if (!pay) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Payment not found', messageTh: 'ไม่พบรายการชำระเงิน' });
    if (n(dto.amount) <= 0) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Amount must be positive', messageTh: 'จำนวนเงินต้องมากกว่าศูนย์' });

    const status = String(pay.status ?? '');
    if (status !== 'Captured' && status !== 'Settled' && status !== 'Refunded') {
      // Voided/Failed/Pending/Authorized payments hold no captured funds to return.
      throw new BadRequestException({ code: 'NOT_REFUNDABLE', message: `Payment in status ${status} cannot be refunded`, messageTh: 'รายการนี้ยังไม่ได้รับชำระ จึงคืนเงินไม่ได้' });
    }

    // sum of prior refunds against this payment
    const [prior] = await db.select({ v: sql<string>`coalesce(sum(${paymentRefunds.amount}),0)` })
      .from(paymentRefunds).where(eq(paymentRefunds.paymentNo, dto.payment_no));
    const already = n(prior?.v);
    const remaining = round2(n(pay.amount) - already);
    if (n(dto.amount) > remaining + 1e-9) {
      throw new BadRequestException({
        code: 'OVER_REFUND',
        message: `Refund ${n(dto.amount)} exceeds remaining refundable ${remaining} (paid ${n(pay.amount)}, already refunded ${already})`,
        messageTh: `จำนวนเงินคืนเกินยอดคงเหลือที่คืนได้ (${remaining})`,
      });
    }
    const fullyRefunded = already + n(dto.amount) >= n(pay.amount) - 1e-9;

    const refundNo = await this.docNo.nextDaily('REF');
    await db.transaction(async (tx: any) => {
      await tx.insert(paymentRefunds).values({
        refundNo, paymentNo: dto.payment_no, tenantId: pay.tenantId, amount: fx(dto.amount, 4),
        reason: dto.reason ?? null, status: 'Refunded', createdBy: user.username,
      });
      // Only flip the payment to Refunded once it is FULLY refunded; partials keep it Captured so
      // further partial refunds remain possible and the payment cannot be voided.
      if (fullyRefunded) await tx.update(payments).set({ status: 'Refunded' }).where(eq(payments.id, pay.id));
    });
    return { refund_no: refundNo, status: 'Refunded', refunded_total: round2(already + n(dto.amount)), remaining_refundable: round2(remaining - n(dto.amount)), fully_refunded: fullyRefunded };
  }

  // PATCH /api/payments/:no/void — void a payment that has not been captured/settled.
  async voidPayment(paymentNo: string, _user: JwtUser) {
    const db = this.db as any;
    const [pay] = await db.select().from(payments).where(eq(payments.paymentNo, paymentNo)).limit(1);
    if (!pay) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Payment not found', messageTh: 'ไม่พบรายการชำระเงิน' });
    const status = String(pay.status ?? '');
    if (status === 'Captured' || status === 'Settled') {
      throw new BadRequestException({ code: 'CANNOT_VOID', message: 'Captured/settled payment cannot be voided — use refund', messageTh: 'รายการที่ชำระแล้วยกเลิกไม่ได้ ให้ใช้การคืนเงิน' });
    }
    await db.update(payments).set({ status: 'Voided' }).where(eq(payments.id, pay.id));
    return { payment_no: paymentNo, status: 'Voided' };
  }

  // PATCH /api/payments/:no/settle — confirm an async tender (PromptPay/Authorized) as Captured.
  // Completes the lifecycle for gateways that settle out-of-band (so a Pending tender is not a dead-end).
  async settle(paymentNo: string, _user: JwtUser) {
    const db = this.db as any;
    const [pay] = await db.select().from(payments).where(eq(payments.paymentNo, paymentNo)).limit(1);
    if (!pay) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Payment not found', messageTh: 'ไม่พบรายการชำระเงิน' });
    const st = String(pay.status ?? '');
    if (st === 'Captured') return { payment_no: paymentNo, status: 'Captured' };
    if (st !== 'Pending' && st !== 'Authorized') {
      throw new BadRequestException({ code: 'CANNOT_SETTLE', message: `Payment in status ${st} cannot be settled`, messageTh: 'รายการนี้ยืนยันการรับชำระไม่ได้' });
    }
    await db.update(payments).set({ status: 'Captured', capturedAt: new Date() }).where(eq(payments.id, pay.id));
    return { payment_no: paymentNo, status: 'Captured' };
  }

  // POST /api/payments/till/open — open a till session with an opening float.
  async openTill(dto: OpenTillDto, user: JwtUser) {
    const db = this.db as any;
    const sessionNo = await this.docNo.nextDaily('TILL');
    // Scope the session to the user's tenant so POS can find "the current open till" per shop.
    await db.insert(tillSessions).values({
      sessionNo, tenantId: user.tenantId ?? null, openedBy: user.username, openingFloat: fx(dto.opening_float, 4), status: 'Open',
    });
    return { session_no: sessionNo, status: 'Open', opening_float: n(dto.opening_float) };
  }

  // Most-recent OPEN till session for a tenant, or null if none is open.
  async currentOpenTill(tenantId: number): Promise<{ id: number; sessionNo: string } | null> {
    const db = this.db as any;
    const [s] = await db.select({ id: tillSessions.id, sessionNo: tillSessions.sessionNo })
      .from(tillSessions)
      .where(and(eq(tillSessions.tenantId, tenantId), sql`${tillSessions.status}::text = 'Open'`))
      .orderBy(desc(tillSessions.openedAt))
      .limit(1);
    return s ? { id: Number(s.id), sessionNo: s.sessionNo } : null;
  }

  // POST /api/payments/till/close — reconcile cash: expected = float + Σ cash captured; variance = counted − expected.
  async closeTill(dto: CloseTillDto, user: JwtUser) {
    const db = this.db as any;
    const [sess] = await db.select().from(tillSessions).where(eq(tillSessions.sessionNo, dto.session_no)).limit(1);
    if (!sess) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Till session not found', messageTh: 'ไม่พบรอบเงินสด' });
    if (String(sess.status) === 'Closed') throw new BadRequestException({ code: 'ALREADY_CLOSED', message: 'Till session already closed', messageTh: 'รอบเงินสดถูกปิดแล้ว' });

    // Cash-IN must include fully-refunded payments (status flips to 'Refunded') so the refund-OUT
    // sum below nets to zero for them — otherwise a fully-refunded cash sale would be subtracted
    // without ever being added, understating expected cash by the full amount.
    const [cash] = await db.select({ v: sql<string>`coalesce(sum(${payments.amount}),0)` }).from(payments)
      .where(and(eq(payments.tillSessionId, Number(sess.id)), sql`${payments.method}::text = 'Cash'`, sql`${payments.status}::text IN ('Captured','Refunded')`));
    // Refunds against cash payments in THIS session reduce drawer cash (join on session+method only).
    const [refunded] = await db.select({ v: sql<string>`coalesce(sum(${paymentRefunds.amount}),0)` })
      .from(paymentRefunds)
      .innerJoin(payments, eq(paymentRefunds.paymentNo, payments.paymentNo))
      .where(and(eq(payments.tillSessionId, Number(sess.id)), sql`${payments.method}::text = 'Cash'`));
    const expectedCash = round2(n(sess.openingFloat) + n(cash?.v) - n(refunded?.v));
    const variance = round2(n(dto.closing_count) - expectedCash);
    await db.update(tillSessions).set({
      closedBy: user.username, closedAt: new Date(), closingCount: fx(dto.closing_count, 4),
      expectedCash: fx(expectedCash, 4), variance: fx(variance, 4), status: 'Closed',
    }).where(eq(tillSessions.id, sess.id));
    return { session_no: dto.session_no, status: 'Closed', expected_cash: expectedCash, closing_count: n(dto.closing_count), variance };
  }

  // GET /api/payments?sale_no= — all tenders attached to a sale.
  async listPaymentsForSale(saleNo: string) {
    const db = this.db as any;
    const rows = await db.select({
      payment_no: payments.paymentNo, sale_no: payments.saleNo, method: payments.method, amount: payments.amount,
      currency: payments.currency, gateway: payments.gateway, gateway_ref: payments.gatewayRef, status: payments.status,
      captured_at: payments.capturedAt, created_at: payments.createdAt,
    }).from(payments).where(eq(payments.saleNo, saleNo)).orderBy(desc(payments.createdAt));
    const out = rows.map((r: any) => ({ ...r, amount: n(r.amount) }));
    return { sale_no: saleNo, payments: out, count: out.length, total_captured: out.filter((r: any) => r.status === 'Captured').reduce((a: number, r: any) => a + r.amount, 0) };
  }
}
