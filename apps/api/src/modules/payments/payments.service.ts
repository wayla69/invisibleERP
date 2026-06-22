import { Inject, Injectable, Optional, NotFoundException, BadRequestException } from '@nestjs/common';
import { sql, eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { payments, paymentRefunds, tillSessions, cashMovements, tenants } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { LedgerService } from '../ledger/ledger.service';
import { n, fx } from '../../database/queries';
import { round2, roundCurrency } from '../tax/money';
import type { JwtUser } from '../../common/decorators';
import { resolveGateway } from './gateways';
import { PosAuditService } from '../pos-audit/pos-audit.service';
import { JournalService } from '../pos-fiscal/journal.service';

export interface RecordTenderDto {
  sale_no: string;
  tenant_id?: number;
  method: string;
  amount: number;
  tip?: number;          // tip portion — persisted separately, NOT folded into amount (cash recon)
  currency?: string;
  gateway?: string;
  till_session_id?: number;
}
export interface RefundDto { payment_no: string; amount: number; reason?: string }
export interface OpenTillDto { opening_float?: number }
export interface CloseTillDto { session_no: string; closing_count: number; denominations?: Record<string, number> }
export interface CashMovementDto { type: 'paid_in' | 'paid_out' | 'drop'; amount: number; reason?: string }

@Injectable()
export class PaymentService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly ledger: LedgerService,
    @Optional() private readonly audit?: PosAuditService,   // wiring: central POS audit trail
    @Optional() private readonly journal?: JournalService,   // wiring: electronic journal
  ) {}

  // POST /api/payments — run a tender against a gateway, persist the result.
  async recordTender(dto: RecordTenderDto, user: JwtUser) {
    const db = this.db as any;
    if (n(dto.amount) <= 0) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Amount must be positive', messageTh: 'จำนวนเงินต้องมากกว่าศูนย์' });
    const currency = dto.currency ?? 'THB';
    const tenantId = dto.tenant_id ?? user.tenantId ?? null;
    const { gateway, name: gatewayName } = resolveGateway(dto.gateway);
    // For PromptPay, hand the tenant's merchant id to the gateway so it emits a real scannable EMVCo QR.
    const promptpayId = gatewayName === 'promptpay' ? await this.tenantPromptPayId(tenantId) : undefined;
    const result = await gateway.authorizeAndCapture(n(dto.amount), currency, dto.method, { sale_no: dto.sale_no, promptpay_id: promptpayId });

    const paymentNo = await this.docNo.nextDaily('PAY');
    const now = new Date();
    await db.insert(payments).values({
      paymentNo, saleNo: dto.sale_no, tenantId, tillSessionId: dto.till_session_id ?? null,
      method: dto.method, amount: fx(dto.amount, 4), tip: fx(dto.tip ?? 0, 4), currency, gateway: gatewayName, gatewayRef: result.ref,
      status: result.status, createdBy: user.username, capturedAt: result.status === 'Captured' ? now : null,
    });
    // gateway_ref is the EMVCo payload for PromptPay → surface it as qr_payload for the POS to render.
    return { payment_no: paymentNo, status: result.status, amount: n(dto.amount), gateway_ref: result.ref, qr_payload: gatewayName === 'promptpay' && promptpayId ? result.ref : null };
  }

  // Current tenant's stored PromptPay merchant id (null if unset).
  private async tenantPromptPayId(tenantId: number | null): Promise<string | undefined> {
    if (tenantId == null) return undefined;
    const [t] = await (this.db as any).select({ pp: tenants.promptpayId }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    return t?.pp ?? undefined;
  }

  // GET /api/payments/promptpay-qr?amount= — a scannable EMVCo QR for the tenant, before any tender is recorded.
  async promptPayQr(amount: number, user: JwtUser) {
    const ppId = await this.tenantPromptPayId(user.tenantId ?? null);
    if (!ppId) throw new BadRequestException({ code: 'NO_PROMPTPAY', message: 'No PromptPay id configured for this business', messageTh: 'ยังไม่ได้ตั้งค่าพร้อมเพย์ของกิจการ' });
    const { gateway } = resolveGateway('promptpay');
    const r = await gateway.authorizeAndCapture(n(amount), 'THB', 'PromptPay', { promptpay_id: ppId });
    return { promptpay_id: ppId, amount: n(amount), qr_payload: r.ref };
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

    // Attribute the refund to the till open NOW (where the cash actually leaves the drawer), not the
    // original sale's till. A cash sale on a since-closed shift refunded today must hit today's drawer.
    const openTill = pay.tenantId != null ? await this.currentOpenTill(Number(pay.tenantId)) : null;

    const refundNo = await this.docNo.nextDaily('REF');
    await db.transaction(async (tx: any) => {
      await tx.insert(paymentRefunds).values({
        refundNo, paymentNo: dto.payment_no, tenantId: pay.tenantId, tillSessionId: openTill?.id ?? null,
        amount: fx(dto.amount, 4), reason: dto.reason ?? null, status: 'Refunded', createdBy: user.username,
      });
      // Only flip the payment to Refunded once it is FULLY refunded; partials keep it Captured so
      // further partial refunds remain possible and the payment cannot be voided.
      if (fullyRefunded) await tx.update(payments).set({ status: 'Refunded' }).where(eq(payments.id, pay.id));
    });
    // wiring (best-effort): central audit + electronic journal
    if (this.audit) { try { await this.audit.record({ action: 'refund', entity: 'payment', entityId: dto.payment_no, meta: { refund_no: refundNo, amount: n(dto.amount), reason: dto.reason } }, user); } catch { /* audit best-effort */ } }
    if (this.journal) { try { await this.journal.append({ doc_type: 'REFUND', doc_no: refundNo, payload: { payment_no: dto.payment_no, amount: n(dto.amount), fully_refunded: fullyRefunded } }, user); } catch { /* journal best-effort */ } }
    return { refund_no: refundNo, status: 'Refunded', refunded_total: round2(already + n(dto.amount)), remaining_refundable: round2(remaining - n(dto.amount)), fully_refunded: fullyRefunded };
  }

  // PATCH /api/payments/:no/void — void a payment that has not been captured/settled.
  async voidPayment(paymentNo: string, user: JwtUser) {
    const db = this.db as any;
    const [pay] = await db.select().from(payments).where(eq(payments.paymentNo, paymentNo)).limit(1);
    if (!pay) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Payment not found', messageTh: 'ไม่พบรายการชำระเงิน' });
    const status = String(pay.status ?? '');
    if (status === 'Captured' || status === 'Settled') {
      throw new BadRequestException({ code: 'CANNOT_VOID', message: 'Captured/settled payment cannot be voided — use refund', messageTh: 'รายการที่ชำระแล้วยกเลิกไม่ได้ ให้ใช้การคืนเงิน' });
    }
    await db.update(payments).set({ status: 'Voided' }).where(eq(payments.id, pay.id));
    // wiring (best-effort): central audit + electronic journal
    if (this.audit) { try { await this.audit.record({ action: 'void', entity: 'payment', entityId: paymentNo, meta: { prior_status: status } }, user); } catch { /* audit best-effort */ } }
    if (this.journal) { try { await this.journal.append({ doc_type: 'VOID', doc_no: paymentNo, payload: { payment_no: paymentNo, prior_status: status } }, user); } catch { /* journal best-effort */ } }
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
      .orderBy(desc(tillSessions.openedAt), desc(tillSessions.id))
      .limit(1);
    return s ? { id: Number(s.id), sessionNo: s.sessionNo } : null;
  }

  // POST /api/payments/till/close — reconcile cash: expected = float + Σ cash captured; variance = counted − expected.
  async closeTill(dto: CloseTillDto, user: JwtUser) {
    const db = this.db as any;
    const [sess] = await db.select().from(tillSessions).where(eq(tillSessions.sessionNo, dto.session_no)).limit(1);
    if (!sess) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Till session not found', messageTh: 'ไม่พบรอบเงินสด' });
    if (String(sess.status) === 'Closed') throw new BadRequestException({ code: 'ALREADY_CLOSED', message: 'Till session already closed', messageTh: 'รอบเงินสดถูกปิดแล้ว' });

    // expected cash now folds in cash movements (paid-in/out/drops) via the shared aggregator.
    const a = await this.aggregateTill(Number(sess.id));
    const expectedCash = roundCurrency(a.expected_cash, 'THB');
    const variance = roundCurrency(n(dto.closing_count) - expectedCash, 'THB');
    await db.update(tillSessions).set({
      closedBy: user.username, closedAt: new Date(), closingCount: fx(dto.closing_count, 4),
      expectedCash: fx(expectedCash, 4), variance: fx(variance, 4), denominations: dto.denominations ?? null, status: 'Closed',
    }).where(eq(tillSessions.id, sess.id));
    return { session_no: dto.session_no, status: 'Closed', expected_cash: expectedCash, closing_count: n(dto.closing_count), variance, z_report: { ...a, counted_cash: n(dto.closing_count), variance, denominations: dto.denominations ?? null } };
  }

  // ── Cash management: drawer movements + X/Z shift report ──

  // record a paid-in / paid-out / drop on an OPEN till; paid_in/out also post GL (drop is drawer-only).
  async recordCashMovement(tillId: number, dto: CashMovementDto, user: JwtUser) {
    const db = this.db as any;
    const [sess] = await db.select().from(tillSessions).where(eq(tillSessions.id, tillId)).limit(1);
    if (!sess) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Till session not found', messageTh: 'ไม่พบรอบเงินสด' });
    if (String(sess.status) === 'Closed') throw new BadRequestException({ code: 'TILL_CLOSED', message: 'Till session is closed', messageTh: 'รอบเงินสดถูกปิดแล้ว' });
    if (n(dto.amount) <= 0) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Amount must be positive', messageTh: 'จำนวนเงินต้องมากกว่าศูนย์' });
    const movementNo = await this.docNo.nextDaily('CASHMOV');
    const amt = roundCurrency(dto.amount, 'THB');
    await db.insert(cashMovements).values({ movementNo, tenantId: sess.tenantId, tillSessionId: tillId, type: dto.type, amount: fx(amt, 4), reason: dto.reason ?? null, createdBy: user.username });
    let journalNo: string | null = null;
    if ((dto.type === 'paid_in' || dto.type === 'paid_out') && !(await this.ledger.alreadyPosted('CASHMOV', movementNo))) {
      const lines = dto.type === 'paid_out'
        ? [{ account_code: '5100', debit: amt }, { account_code: '1000', credit: amt }]
        : [{ account_code: '1000', debit: amt }, { account_code: '5100', credit: amt }];
      const je: any = await this.ledger.postEntry({ source: 'CASHMOV', sourceRef: movementNo, tenantId: sess.tenantId ?? null, memo: `Cash ${dto.type} ${movementNo}`, createdBy: user.username, lines });
      journalNo = je?.entry_no ?? null;
      await db.update(cashMovements).set({ journalNo }).where(eq(cashMovements.movementNo, movementNo));
    }
    return { movement_no: movementNo, type: dto.type, amount: n(amt), till_session_id: tillId, journal_no: journalNo };
  }

  // shared aggregation for X-report / Z-report / closeTill
  private async aggregateTill(sessId: number) {
    const db = this.db as any;
    const captured = sql`${payments.status}::text IN ('Captured','Settled','Refunded')`;
    const [gross] = await db.select({ v: sql<string>`coalesce(sum(${payments.amount}),0)` }).from(payments).where(and(eq(payments.tillSessionId, sessId), captured));
    const byMethod = await db.select({ method: payments.method, amount: sql<string>`coalesce(sum(${payments.amount}),0)`, cnt: sql<string>`count(*)` }).from(payments).where(and(eq(payments.tillSessionId, sessId), captured)).groupBy(payments.method);
    const [cashSales] = await db.select({ v: sql<string>`coalesce(sum(${payments.amount}),0)` }).from(payments).where(and(eq(payments.tillSessionId, sessId), sql`${payments.method}::text = 'Cash'`, sql`${payments.status}::text IN ('Captured','Refunded')`));
    // Cash refunds reduce THIS till's drawer only if the refund was processed against it (till the cash
    // left), keyed by payment_refunds.till_session_id — not the original sale's till. Still gated to Cash
    // tenders (a card refund moves no drawer cash).
    const [cashRefunds] = await db.select({ v: sql<string>`coalesce(sum(${paymentRefunds.amount}),0)` }).from(paymentRefunds).innerJoin(payments, eq(paymentRefunds.paymentNo, payments.paymentNo)).where(and(eq(paymentRefunds.tillSessionId, sessId), sql`${payments.method}::text = 'Cash'`));
    const mv = await db.select({ type: cashMovements.type, v: sql<string>`coalesce(sum(${cashMovements.amount}),0)` }).from(cashMovements).where(eq(cashMovements.tillSessionId, sessId)).groupBy(cashMovements.type);
    const paidIn = n(mv.find((m: any) => m.type === 'paid_in')?.v), paidOut = n(mv.find((m: any) => m.type === 'paid_out')?.v), drops = n(mv.find((m: any) => m.type === 'drop')?.v);
    const [txn] = await db.select({ c: sql<string>`count(*)` }).from(payments).where(and(eq(payments.tillSessionId, sessId), captured));
    const [voids] = await db.select({ c: sql<string>`count(*)` }).from(payments).where(and(eq(payments.tillSessionId, sessId), sql`${payments.status}::text = 'Voided'`));
    const [sess] = await db.select({ f: tillSessions.openingFloat }).from(tillSessions).where(eq(tillSessions.id, sessId)).limit(1);
    const openingFloat = n(sess?.f);
    const expected = roundCurrency(openingFloat + n(cashSales?.v) + paidIn - paidOut - drops - n(cashRefunds?.v), 'THB');
    return {
      opening_float: openingFloat, gross_sales: roundCurrency(n(gross?.v), 'THB'),
      by_method: byMethod.map((m: any) => ({ method: m.method, amount: roundCurrency(n(m.amount), 'THB'), count: Number(m.cnt) })),
      cash_sales: roundCurrency(n(cashSales?.v), 'THB'), cash_refunds: roundCurrency(n(cashRefunds?.v), 'THB'),
      paid_in: paidIn, paid_out: paidOut, drops, expected_cash: expected, txn_count: Number(txn?.c), void_count: Number(voids?.c),
    };
  }

  // X-report — mid-shift, non-resetting, works on an open till. No writes.
  async xReport(tillId: number, _user: JwtUser) {
    const db = this.db as any;
    const [sess] = await db.select().from(tillSessions).where(eq(tillSessions.id, tillId)).limit(1);
    if (!sess) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Till session not found', messageTh: 'ไม่พบรอบเงินสด' });
    const a = await this.aggregateTill(tillId);
    return { report: 'X', session_no: sess.sessionNo, status: sess.status, ...a, counted_cash: null, variance: null };
  }

  // Z-report — shift summary at/after close.
  async zReport(tillId: number, _user: JwtUser) {
    const db = this.db as any;
    const [sess] = await db.select().from(tillSessions).where(eq(tillSessions.id, tillId)).limit(1);
    if (!sess) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Till session not found', messageTh: 'ไม่พบรอบเงินสด' });
    const a = await this.aggregateTill(tillId);
    const closed = String(sess.status) === 'Closed';
    return { report: 'Z', session_no: sess.sessionNo, status: sess.status, ...a, counted_cash: closed ? n(sess.closingCount) : null, variance: closed ? n(sess.variance) : null, denominations: sess.denominations ?? null };
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
