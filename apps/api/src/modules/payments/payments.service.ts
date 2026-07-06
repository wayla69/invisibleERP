import { Inject, Injectable, Optional, NotFoundException, BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { sql, eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { payments, paymentRefunds, tillSessions, cashMovements, tenants, refundRequests, xzReports, xzReportDenominations } from '../../database/schema';
import { createHash } from 'node:crypto';
import { DocNumberService } from '../../common/doc-number.service';
import { LedgerService } from '../ledger/ledger.service';
import { n, fx } from '../../database/queries';
import { round2, roundCurrency } from '../tax/money';
import type { JwtUser } from '../../common/decorators';
import { resolveGateway } from './gateways';
import { PosAuditService } from '../pos/audit/pos-audit.service';
import { JournalService } from '../pos/fiscal/journal.service';
import { QrService } from '../qr/qr.service';

// POS-01: cash over/short at/above this absolute THB amount needs manager approval (maker-checker);
// below it the over/short posts to GL immediately. A flat threshold for now — a tenant-level override
// can replace this constant without changing the close/approve flow.
const CASH_VARIANCE_THRESHOLD = 100;
// REV-16: a standalone refund at/above this absolute THB amount needs a different user's approval
// (maker-checker, anti-fraud); below it the refund runs immediately. Flat threshold for now.
const REFUND_APPROVAL_THRESHOLD = 1000;

export interface RecordTenderDto {
  sale_no: string;
  tenant_id?: number;
  method: string;
  amount: number;
  tip?: number;          // tip portion — persisted separately, NOT folded into amount (cash recon)
  currency?: string;
  gateway?: string;
  token?: string;             // card token / wallet source from the terminal SDK — for a real PSP charge
  till_session_id?: number;
  idempotency_key?: string;   // C1: retries with the same key return the original tender, never re-charge
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
    @Optional() private readonly qr?: QrService,             // wiring: render the PromptPay QR as an image
  ) {}

  // POST /api/payments — run a tender against a gateway, persist the result.
  //
  // C1 (idempotency): a retried/double-submitted tender carrying the same idempotency_key returns the
  //   ORIGINAL tender instead of capturing again. The unique index ux_payments_idem makes concurrent
  //   retries collapse to a single row (the loser of the insert race reads back the winner).
  // C2 (capture safety): the row is persisted BEFORE the gateway is contacted, so a capture that
  //   succeeds at the PSP but fails to persist is never an orphaned, unrecorded charge — it survives as
  //   a row to reconcile. A gateway error flips the row to 'Failed' rather than leaving it dangling.
  async recordTender(dto: RecordTenderDto, user: JwtUser) {
    const db = this.db;
    if (n(dto.amount) <= 0) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Amount must be positive', messageTh: 'จำนวนเงินต้องมากกว่าศูนย์' });
    const currency = dto.currency ?? 'THB';
    // Tenant is derived from the authenticated user, never from the request body (no cross-tenant tender).
    const tenantId = user.tenantId ?? dto.tenant_id ?? null;
    const { gateway, name: gatewayName } = resolveGateway(dto.gateway);
    const key = dto.idempotency_key ?? null;

    // Fast path: a retry whose tender already landed returns the original result — no second capture.
    if (key) {
      const existing = await this.findByIdempotencyKey(key);
      if (existing) return this.tenderResult(existing, gatewayName);
    }

    const promptpayId = gatewayName === 'promptpay' ? await this.tenantPromptPayId(tenantId) : undefined;
    const paymentNo = await this.docNo.nextDaily('PAY');

    // Persist a Pending row first. ON CONFLICT DO NOTHING absorbs the concurrent-retry race on the key.
    const inserted = await db.insert(payments).values({
      paymentNo, saleNo: dto.sale_no, tenantId, tillSessionId: dto.till_session_id ?? null,
      method: dto.method, amount: fx(dto.amount, 4), tip: fx(dto.tip ?? 0, 4), currency, gateway: gatewayName,
      status: 'Pending', idempotencyKey: key, createdBy: user.username,
    }).onConflictDoNothing({ target: payments.idempotencyKey }).returning({ id: payments.id });

    // Lost the insert race → the winner already (will) capture; return its row.
    if (!inserted.length) {
      const existing = key ? await this.findByIdempotencyKey(key) : null;
      if (existing) return this.tenderResult(existing, gatewayName);
      throw new ConflictException({ code: 'DUPLICATE_TENDER', message: 'Duplicate tender already in progress', messageTh: 'มีรายการชำระซ้ำกำลังดำเนินการ' });
    }

    let result;
    try {
      result = await gateway.authorizeAndCapture(n(dto.amount), currency, dto.method, { sale_no: dto.sale_no, promptpay_id: promptpayId, token: dto.token });
    } catch (e: any) {
      // A PSP decline (or unknown outcome) is a normal business result, not an exception to throw: if we
      // rethrew, the per-request transaction would roll back and the Failed row would vanish, leaving no
      // audit trail of the attempt. Instead we COMMIT the row as Failed (with the decline reason) and
      // RETURN it — durable evidence that a card was attempted and declined, and never reported Captured.
      const code = e?.response?.code ?? e?.code ?? 'PSP_ERROR';
      const message = e?.response?.message ?? e?.message ?? String(e);
      await db.update(payments).set({ status: 'Failed', gatewayRef: `declined:${code}: ${message}`.slice(0, 480) }).where(eq(payments.paymentNo, paymentNo));
      return { payment_no: paymentNo, status: 'Failed', amount: n(dto.amount), gateway_ref: null, error: code, error_message: message };
    }
    await db.update(payments).set({
      status: result.status, gatewayRef: result.ref, capturedAt: result.status === 'Captured' ? new Date() : null,
    }).where(eq(payments.paymentNo, paymentNo));

    // gateway_ref is the EMVCo payload for PromptPay → surface it as qr_payload for the POS to render.
    return { payment_no: paymentNo, status: result.status, amount: n(dto.amount), gateway_ref: result.ref, qr_payload: gatewayName === 'promptpay' && promptpayId ? result.ref : null };
  }

  // Look up a tender by its idempotency key (globally unique). Used to replay a retried capture.
  private async findByIdempotencyKey(key: string): Promise<any | null> {
    const [row] = await this.db.select().from(payments).where(eq(payments.idempotencyKey, key)).limit(1);
    return row ?? null;
  }

  // Shape an existing payment row into the recordTender response (replayed=true marks the dedupe).
  private tenderResult(row: any, gatewayName: string) {
    return {
      payment_no: row.paymentNo, status: row.status, amount: n(row.amount), gateway_ref: row.gatewayRef,
      qr_payload: gatewayName === 'promptpay' ? row.gatewayRef : null, replayed: true,
    };
  }

  // Current tenant's stored PromptPay merchant id (null if unset).
  private async tenantPromptPayId(tenantId: number | null): Promise<string | undefined> {
    if (tenantId == null) return undefined;
    const [t] = await this.db.select({ pp: tenants.promptpayId }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    return t?.pp ?? undefined;
  }

  // GET /api/payments/promptpay-qr?amount= — a scannable EMVCo QR for the tenant, before any tender is recorded.
  async promptPayQr(amount: number, user: JwtUser) {
    const ppId = await this.tenantPromptPayId(user.tenantId ?? null);
    if (!ppId) throw new BadRequestException({ code: 'NO_PROMPTPAY', message: 'No PromptPay id configured for this business', messageTh: 'ยังไม่ได้ตั้งค่าพร้อมเพย์ของกิจการ' });
    const { gateway } = resolveGateway('promptpay');
    const r = await gateway.authorizeAndCapture(n(amount), 'THB', 'PromptPay', { promptpay_id: ppId });
    // Render the EMVCo payload to a scannable QR image so the POS can show it directly (data-URL PNG).
    const qrImage = r.ref && this.qr ? await this.qr.dataUrl(String(r.ref), 320) : null;
    return { promptpay_id: ppId, amount: n(amount), qr_payload: r.ref, qr_image: qrImage };
  }

  // POST /api/payments/refunds — refund a captured payment.
  // Guards against over-refund by accumulation: the new refund + all prior refunds must not
  // exceed the captured amount. Only Captured/Settled payments are refundable.
  // `outerTx` lets a caller (e.g. ReturnsService) run the refund inside ITS transaction so the refund,
  // restock and return record commit atomically. When present we reuse that tx; otherwise we own one.
  // Either way the payment row is locked FOR UPDATE and prior refunds are summed UNDER the lock, so two
  // concurrent refunds against the same payment can never jointly exceed the captured amount (over-refund).
  async refund(dto: RefundDto, user: JwtUser, outerTx?: any, opts?: { force?: boolean }) {
    if (n(dto.amount) <= 0) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Amount must be positive', messageTh: 'จำนวนเงินต้องมากกว่าศูนย์' });

    // REV-16 maker-checker: a STANDALONE refund (no outerTx — a goods-return refund is authorized by the
    // return) at/above the materiality threshold is parked as a request and moves no money until a DIFFERENT
    // user approves. opts.force lets approveRefund run the real refund past the gate.
    if (!outerTx && !opts?.force && n(dto.amount) >= REFUND_APPROVAL_THRESHOLD) {
      return this.requestRefund(dto, user);
    }

    const refundNo = await this.docNo.nextDaily('REF');

    const run = async (tx: any) => {
      const [pay] = await tx.select().from(payments).where(eq(payments.paymentNo, dto.payment_no)).for('update').limit(1);
      if (!pay) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Payment not found', messageTh: 'ไม่พบรายการชำระเงิน' });

      const status = String(pay.status ?? '');
      if (status !== 'Captured' && status !== 'Settled' && status !== 'Refunded') {
        // Voided/Failed/Pending/Authorized payments hold no captured funds to return.
        throw new BadRequestException({ code: 'NOT_REFUNDABLE', message: `Payment in status ${status} cannot be refunded`, messageTh: 'รายการนี้ยังไม่ได้รับชำระ จึงคืนเงินไม่ได้' });
      }

      // sum of prior refunds against this payment — read under the row lock to defeat the TOCTOU race
      const [prior] = await tx.select({ v: sql<string>`coalesce(sum(${paymentRefunds.amount}),0)` })
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

      await tx.insert(paymentRefunds).values({
        refundNo, paymentNo: dto.payment_no, tenantId: pay.tenantId, tillSessionId: openTill?.id ?? null,
        amount: fx(dto.amount, 4), reason: dto.reason ?? null, status: 'Refunded', createdBy: user.username,
      });
      // Only flip the payment to Refunded once it is FULLY refunded; partials keep it Captured so
      // further partial refunds remain possible and the payment cannot be voided.
      if (fullyRefunded) await tx.update(payments).set({ status: 'Refunded' }).where(eq(payments.id, pay.id));
      return { refund_no: refundNo, status: 'Refunded', refunded_total: round2(already + n(dto.amount)), remaining_refundable: round2(remaining - n(dto.amount)), fully_refunded: fullyRefunded };
    };

    const res = outerTx ? await run(outerTx) : await this.db.transaction(run);

    // wiring (best-effort): central audit + electronic journal. Only fired when WE own the tx — when
    // nested, the refund commits with the caller's tx and the caller owns the post-commit side effects,
    // so we must not record an audit/journal line for a refund that may still be rolled back.
    if (!outerTx) {
      if (this.audit) { try { await this.audit.record({ action: 'refund', entity: 'payment', entityId: dto.payment_no, meta: { refund_no: refundNo, amount: n(dto.amount), reason: dto.reason } }, user); } catch { /* audit best-effort */ } }
      if (this.journal) { try { await this.journal.append({ doc_type: 'REFUND', doc_no: refundNo, payload: { payment_no: dto.payment_no, amount: n(dto.amount), fully_refunded: res.fully_refunded } }, user); } catch { /* journal best-effort */ } }
    }
    return res;
  }

  // REV-16: park a large refund as a request (light-validate; no money moves until approved).
  // Runs under a row lock on the payment, and counts BOTH settled refunds AND other still-pending requests,
  // so two concurrent large requests can't each pass the remaining-amount check and later be approved into an
  // over-refund (the approval path re-checks under its own lock, but we refuse to even queue an over-commit).
  private async requestRefund(dto: RefundDto, user: JwtUser) {
    return await this.db.transaction(async (tx: any) => {
      const [pay] = await tx.select().from(payments).where(eq(payments.paymentNo, dto.payment_no)).for('update').limit(1);
      if (!pay) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Payment not found', messageTh: 'ไม่พบรายการชำระเงิน' });
      const status = String(pay.status ?? '');
      if (status !== 'Captured' && status !== 'Settled' && status !== 'Refunded') throw new BadRequestException({ code: 'NOT_REFUNDABLE', message: `Payment in status ${status} cannot be refunded`, messageTh: 'รายการนี้ยังไม่ได้รับชำระ จึงคืนเงินไม่ได้' });
      const [prior] = await tx.select({ v: sql<string>`coalesce(sum(${paymentRefunds.amount}),0)` }).from(paymentRefunds).where(eq(paymentRefunds.paymentNo, dto.payment_no));
      const [pending] = await tx.select({ v: sql<string>`coalesce(sum(${refundRequests.amount}),0)` }).from(refundRequests).where(and(eq(refundRequests.paymentNo, dto.payment_no), eq(refundRequests.status, 'PendingApproval')));
      const committed = n(prior?.v) + n(pending?.v); // settled + already-queued
      const remaining = round2(n(pay.amount) - committed);
      if (n(dto.amount) > remaining + 1e-9) throw new BadRequestException({ code: 'OVER_REFUND', message: `Refund ${n(dto.amount)} exceeds remaining refundable ${remaining} (incl. pending requests)`, messageTh: `จำนวนเงินคืนเกินยอดคงเหลือที่คืนได้ (${remaining})` });
      const [req] = await tx.insert(refundRequests).values({ tenantId: pay.tenantId, paymentNo: dto.payment_no, amount: fx(dto.amount, 4), reason: dto.reason ?? null, status: 'PendingApproval', requestedBy: user.username }).returning({ id: refundRequests.id });
      return { status: 'PendingApproval', request_id: Number(req.id), payment_no: dto.payment_no, amount: n(dto.amount), message: 'Refund needs manager approval', messageTh: 'การคืนเงินต้องรอผู้จัดการอนุมัติ' };
    });
  }

  // POST /api/payments/refund-requests/:id/approve — a DIFFERENT user approves a parked refund → runs it.
  async approveRefund(requestId: number, approver: JwtUser) {
    const db = this.db;
    const [req] = await db.select().from(refundRequests).where(eq(refundRequests.id, requestId)).limit(1);
    if (!req) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Refund request not found', messageTh: 'ไม่พบคำขอคืนเงิน' });
    if (String(req.status) !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Request is ${req.status}`, messageTh: 'คำขอนี้ไม่ได้รออนุมัติ' });
    if (req.requestedBy && req.requestedBy === approver.username) throw new ForbiddenException({ code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot approve a refund you requested', messageTh: 'ผู้ขออนุมัติคืนเงินของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    // run the real refund past the gate (force), crediting it to the approver (who authorizes the money-out).
    const res: any = await this.refund({ payment_no: req.paymentNo, amount: n(req.amount), reason: req.reason ?? undefined }, approver, undefined, { force: true });
    await db.update(refundRequests).set({ status: 'Approved', approvedBy: approver.username, refundNo: res.refund_no, approvedAt: new Date() }).where(eq(refundRequests.id, requestId));
    return { request_id: requestId, status: 'Approved', refund_no: res.refund_no, approved_by: approver.username, requested_by: req.requestedBy };
  }

  // POST /api/payments/refund-requests/:id/reject
  async rejectRefund(requestId: number, approver: JwtUser, reason?: string) {
    const db = this.db;
    const [req] = await db.select().from(refundRequests).where(eq(refundRequests.id, requestId)).limit(1);
    if (!req) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Refund request not found', messageTh: 'ไม่พบคำขอคืนเงิน' });
    if (String(req.status) !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Request is ${req.status}`, messageTh: 'คำขอนี้ไม่ได้รออนุมัติ' });
    if (req.requestedBy && req.requestedBy === approver.username) throw new ForbiddenException({ code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot reject a refund you requested', messageTh: 'ผู้ขอปฏิเสธคำขอของตนเองไม่ได้' });
    await db.update(refundRequests).set({ status: 'Rejected', approvedBy: approver.username, approvedAt: new Date() }).where(eq(refundRequests.id, requestId));
    return { request_id: requestId, status: 'Rejected', rejected_by: approver.username, reason: reason ?? null };
  }

  // GET /api/payments/refund-requests — the refund-approval worklist (tenant-scoped).
  async listRefundRequests(status: string | undefined, user: JwtUser) {
    const db = this.db;
    const conds = [eq(refundRequests.tenantId, user.tenantId as number)];
    if (status) conds.push(eq(refundRequests.status, status));
    const rows = await db.select().from(refundRequests).where(and(...conds)).orderBy(desc(refundRequests.createdAt)).limit(300);
    return { requests: rows.map((r: any) => ({ id: Number(r.id), payment_no: r.paymentNo, amount: n(r.amount), reason: r.reason, status: r.status, requested_by: r.requestedBy, approved_by: r.approvedBy, refund_no: r.refundNo, created_at: r.createdAt })), count: rows.length, pending: rows.filter((r: any) => r.status === 'PendingApproval').length };
  }

  // PATCH /api/payments/:no/void — void a payment that has not been captured/settled.
  async voidPayment(paymentNo: string, user: JwtUser) {
    const db = this.db;
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

  // G14 (maker-checker audit — detective control): POS voids and sub-threshold refunds are single-user BY
  // DESIGN (till speed; large refunds already park for approval via REV-16, and the pos_sell/pos_refund/
  // pos_till split + till-variance approval are the compensating controls). This read-only EXCEPTION REPORT
  // surfaces every void + refund in a window for periodic independent review, so the residual risk is
  // detective-covered rather than unmonitored. Tenant-scoped (RLS); optional [from,to] date filter (YYYY-MM-DD).
  async voidRefundExceptions(range: { from?: string; to?: string }, user: JwtUser) {
    const db = this.db;
    const tenantId = user.tenantId ?? null;
    const dateConds = (col: any) => {
      const c: any[] = [];
      if (range.from) c.push(sql`${col} >= ${range.from}`);
      if (range.to) c.push(sql`${col} < (${range.to}::date + 1)`);
      return c;
    };
    const voidConds = [sql`${payments.status}::text = 'Voided'`, ...dateConds(payments.createdAt)];
    if (tenantId != null) voidConds.push(eq(payments.tenantId, tenantId));
    const voids = await db.select({ paymentNo: payments.paymentNo, saleNo: payments.saleNo, method: payments.method, amount: payments.amount, createdBy: payments.createdBy, createdAt: payments.createdAt })
      .from(payments).where(and(...voidConds)).orderBy(desc(payments.createdAt)).limit(500);
    const refConds = [...dateConds(paymentRefunds.createdAt)];
    if (tenantId != null) refConds.push(eq(paymentRefunds.tenantId, tenantId));
    const refunds = await db.select({ refundNo: paymentRefunds.refundNo, paymentNo: paymentRefunds.paymentNo, amount: paymentRefunds.amount, reason: paymentRefunds.reason, createdBy: paymentRefunds.createdBy, createdAt: paymentRefunds.createdAt })
      .from(paymentRefunds).where(refConds.length ? and(...refConds) : undefined).orderBy(desc(paymentRefunds.createdAt)).limit(500);
    const voidTotal = round2(voids.reduce((a: number, v: any) => a + n(v.amount), 0));
    const refundTotal = round2(refunds.reduce((a: number, r: any) => a + n(r.amount), 0));
    return {
      from: range.from ?? null, to: range.to ?? null,
      voids: voids.map((v: any) => ({ payment_no: v.paymentNo, sale_no: v.saleNo, method: v.method, amount: n(v.amount), by: v.createdBy, at: v.createdAt })),
      refunds: refunds.map((r: any) => ({ refund_no: r.refundNo, payment_no: r.paymentNo, amount: n(r.amount), reason: r.reason, by: r.createdBy, at: r.createdAt })),
      void_count: voids.length, refund_count: refunds.length, void_total: voidTotal, refund_total: refundTotal,
    };
  }

  // PATCH /api/payments/:no/settle — confirm an async tender (PromptPay/Authorized) as Captured.
  // Completes the lifecycle for gateways that settle out-of-band (so a Pending tender is not a dead-end).
  async settle(paymentNo: string, _user: JwtUser) {
    const db = this.db;
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
    const db = this.db;
    const sessionNo = await this.docNo.nextDaily('TILL');
    // Scope the session to the user's tenant so POS can find "the current open till" per shop.
    await db.insert(tillSessions).values({
      sessionNo, tenantId: user.tenantId ?? null, openedBy: user.username, openingFloat: fx(dto.opening_float, 4), status: 'Open',
    });
    return { session_no: sessionNo, status: 'Open', opening_float: n(dto.opening_float) };
  }

  // Most-recent OPEN till session for a tenant, or null if none is open.
  async currentOpenTill(tenantId: number): Promise<{ id: number; sessionNo: string } | null> {
    const db = this.db;
    const [s] = await db.select({ id: tillSessions.id, sessionNo: tillSessions.sessionNo })
      .from(tillSessions)
      .where(and(eq(tillSessions.tenantId, tenantId), sql`${tillSessions.status}::text = 'Open'`))
      .orderBy(desc(tillSessions.openedAt), desc(tillSessions.id))
      .limit(1);
    return s ? { id: Number(s.id), sessionNo: s.sessionNo } : null;
  }

  // GET /api/payments/till/current — the caller's tenant's current open till (or null). Lets the POS
  // login flow decide whether to open a shift, so "เข้าสู่ระบบ / เปิดกะ" never opens a duplicate.
  async currentTill(user: JwtUser): Promise<{ open: { id: number; session_no: string } | null }> {
    if (user.tenantId == null) return { open: null };
    const t = await this.currentOpenTill(Number(user.tenantId));
    return { open: t ? { id: t.id, session_no: t.sessionNo } : null };
  }

  // POST /api/payments/till/close — reconcile cash: expected = float + Σ cash captured; variance = counted − expected.
  async closeTill(dto: CloseTillDto, user: JwtUser) {
    const db = this.db;
    const [sess] = await db.select().from(tillSessions).where(eq(tillSessions.sessionNo, dto.session_no)).limit(1);
    if (!sess) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Till session not found', messageTh: 'ไม่พบรอบเงินสด' });
    if (String(sess.status) === 'Closed') throw new BadRequestException({ code: 'ALREADY_CLOSED', message: 'Till session already closed', messageTh: 'รอบเงินสดถูกปิดแล้ว' });

    // expected cash now folds in cash movements (paid-in/out/drops) via the shared aggregator.
    const a = await this.aggregateTill(Number(sess.id));
    const expectedCash = roundCurrency(a.expected_cash, 'THB');
    const variance = roundCurrency(n(dto.closing_count) - expectedCash, 'THB');

    // POS-01: post the cash over/short to GL so book-cash (1000) tracks the physical count.
    //   short (counted < expected): Dr 5830 Cash Over/Short, Cr 1000 Cash
    //   over  (counted > expected): Dr 1000 Cash,            Cr 5830 Cash Over/Short
    // A variance over the materiality threshold posts a DRAFT JE (pendingApproval) and parks the
    // session in PendingApproval — a different user (manager) must approve it (maker-checker, GL-05
    // SoD). Sub-threshold variances post immediately (no approval required). The till still CLOSES
    // either way — the cash has physically left the drawer; only the GL clearing is gated.
    let varianceJournalNo: string | null = null;
    let varianceStatus: 'NotRequired' | 'PendingApproval' = 'NotRequired';
    if (Math.abs(variance) >= 0.005 && !(await this.ledger.alreadyPosted('TILL_CLOSE', dto.session_no, sess.tenantId ?? null))) {
      const material = Math.abs(variance) > CASH_VARIANCE_THRESHOLD;
      const v = Math.abs(variance);
      const lines = variance < 0
        ? [{ account_code: '5830', debit: v }, { account_code: '1000', credit: v }]
        : [{ account_code: '1000', debit: v }, { account_code: '5830', credit: v }];
      const je: any = await this.ledger.postEntry({
        source: 'TILL_CLOSE', sourceRef: dto.session_no, tenantId: sess.tenantId ?? null,
        memo: `Till close variance ${dto.session_no} (${variance < 0 ? 'short' : 'over'} ${v})`,
        createdBy: user.username, pendingApproval: material, lines,
      });
      varianceJournalNo = je?.entry_no ?? null;
      varianceStatus = material ? 'PendingApproval' : 'NotRequired';
    }

    await db.update(tillSessions).set({
      closedBy: user.username, closedAt: new Date(), closingCount: fx(dto.closing_count, 4),
      expectedCash: fx(expectedCash, 4), variance: fx(variance, 4), denominations: dto.denominations ?? null, status: 'Closed',
      varianceJournalNo, varianceStatus,
    }).where(eq(tillSessions.id, sess.id));
    return { session_no: dto.session_no, status: 'Closed', expected_cash: expectedCash, closing_count: n(dto.closing_count), variance, variance_status: varianceStatus, variance_journal_no: varianceJournalNo, z_report: { ...a, counted_cash: n(dto.closing_count), variance, denominations: dto.denominations ?? null } };
  }

  // POST /api/payments/till/variance/:sessionNo/approve — manager clears a material cash variance.
  // Maker-checker: the approver must differ from the cashier who closed the till (enforced by
  // ledger.approveEntry → SOD_VIOLATION). Approving makes the parked Draft over/short JE effective.
  async approveVariance(sessionNo: string, approver: JwtUser) {
    const db = this.db;
    const [sess] = await db.select().from(tillSessions).where(eq(tillSessions.sessionNo, sessionNo)).limit(1);
    if (!sess) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Till session not found', messageTh: 'ไม่พบรอบเงินสด' });
    if (String(sess.varianceStatus) !== 'PendingApproval' || !sess.varianceJournalNo) {
      throw new BadRequestException({ code: 'NOT_PENDING', message: 'No cash variance pending approval for this till', messageTh: 'รอบเงินสดนี้ไม่มีผลต่างที่รออนุมัติ' });
    }
    await this.ledger.approveEntry(sess.varianceJournalNo, approver); // SoD: approver ≠ preparer (binds Admin)
    await db.update(tillSessions).set({ varianceStatus: 'Approved', varianceApprovedBy: approver.username, varianceApprovedAt: new Date() }).where(eq(tillSessions.id, sess.id));
    return { session_no: sessionNo, variance_status: 'Approved', variance_journal_no: sess.varianceJournalNo, variance: n(sess.variance), approved_by: approver.username, closed_by: sess.closedBy };
  }

  // POST /api/payments/till/variance/:sessionNo/reject — manager rejects a material cash variance.
  // Voids the parked Draft over/short JE (the discrepancy stays recorded on the till for follow-up).
  async rejectVariance(sessionNo: string, approver: JwtUser, reason?: string) {
    const db = this.db;
    const [sess] = await db.select().from(tillSessions).where(eq(tillSessions.sessionNo, sessionNo)).limit(1);
    if (!sess) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Till session not found', messageTh: 'ไม่พบรอบเงินสด' });
    if (String(sess.varianceStatus) !== 'PendingApproval' || !sess.varianceJournalNo) {
      throw new BadRequestException({ code: 'NOT_PENDING', message: 'No cash variance pending approval for this till', messageTh: 'รอบเงินสดนี้ไม่มีผลต่างที่รออนุมัติ' });
    }
    await this.ledger.rejectEntry(sess.varianceJournalNo, approver, reason); // SoD: rejecter ≠ preparer
    await db.update(tillSessions).set({ varianceStatus: 'Rejected', varianceApprovedBy: approver.username, varianceApprovedAt: new Date() }).where(eq(tillSessions.id, sess.id));
    return { session_no: sessionNo, variance_status: 'Rejected', variance_journal_no: sess.varianceJournalNo, rejected_by: approver.username };
  }

  // ── Cash management: drawer movements + X/Z shift report ──

  // record a paid-in / paid-out / drop on an OPEN till; paid_in/out also post GL (drop is drawer-only).
  async recordCashMovement(tillId: number, dto: CashMovementDto, user: JwtUser) {
    const db = this.db;
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
    const db = this.db;
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
    const db = this.db;
    const [sess] = await db.select().from(tillSessions).where(eq(tillSessions.id, tillId)).limit(1);
    if (!sess) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Till session not found', messageTh: 'ไม่พบรอบเงินสด' });
    const a = await this.aggregateTill(tillId);
    return { report: 'X', session_no: sess.sessionNo, status: sess.status, ...a, counted_cash: null, variance: null };
  }

  // Z-report — shift summary at/after close.
  async zReport(tillId: number, _user: JwtUser) {
    const db = this.db;
    const [sess] = await db.select().from(tillSessions).where(eq(tillSessions.id, tillId)).limit(1);
    if (!sess) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Till session not found', messageTh: 'ไม่พบรอบเงินสด' });
    const a = await this.aggregateTill(tillId);
    const closed = String(sess.status) === 'Closed';
    return { report: 'Z', session_no: sess.sessionNo, status: sess.status, ...a, counted_cash: closed ? n(sess.closingCount) : null, variance: closed ? n(sess.variance) : null, denominations: sess.denominations ?? null };
  }

  // POS-07 — sign the Z-report: snapshot the closed till's shift totals into an immutable, tamper-evident
  // record with a manager attestation (pos_close) + denomination breakdown. content_hash = sha256 over the
  // canonical totals, so any later edit to the persisted row is detectable. Idempotent per till: a second
  // sign returns the existing signed record (no duplicate Z-tape).
  async signZReport(sessionNo: string, user: JwtUser, denominations?: Record<string, number>) {
    const db = this.db;
    const [sess] = await db.select().from(tillSessions).where(eq(tillSessions.sessionNo, sessionNo)).limit(1);
    if (!sess) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Till session not found', messageTh: 'ไม่พบรอบเงินสด' });
    if (String(sess.status) !== 'Closed') throw new BadRequestException({ code: 'TILL_NOT_CLOSED', message: 'Z-report can only be signed for a closed till', messageTh: 'ลงนามรายงาน Z ได้เฉพาะรอบที่ปิดแล้ว' });

    const [existing] = await db.select().from(xzReports)
      .where(and(eq(xzReports.tillSessionId, Number(sess.id)), sql`${xzReports.reportType}::text = 'Z'`, sql`${xzReports.status}::text = 'SIGNED'`)).limit(1);
    if (existing) return { ...(await this.getXzReport(Number(existing.id))), already: true };

    const a = await this.aggregateTill(Number(sess.id));
    const cardTotal = roundCurrency(n(a.gross_sales) - n(a.cash_sales), 'THB');
    const denoms = denominations ?? (sess.denominations as Record<string, number> | null) ?? {};
    const counted = n(sess.closingCount);
    const variance = n(sess.variance);
    // content_hash covers exactly the persisted scalars + denomination rows, so getXzReport can recompute
    // it from the stored record and flag any later tamper (`hash_valid`). Fixed precision + sorted denoms
    // make it deterministic.
    const denomPairs = Object.entries(denoms).filter(([, c]) => Number(c) > 0).map(([d, c]) => ({ denomination: Number(d), count: Number(c), total: Number(d) * Number(c) }));
    const contentHash = this.hashXz(Number(sess.id), n(a.gross_sales), n(a.cash_sales), cardTotal, n(a.cash_refunds), n(a.expected_cash), counted, variance, denomPairs);
    const html = this.renderZHtml(sessionNo, a, cardTotal, counted, variance, denoms, user.username, contentHash);

    const [rep] = await db.insert(xzReports).values({
      tenantId: sess.tenantId ?? null, tillSessionId: Number(sess.id), reportType: 'Z',
      generatedBy: user.username, grossSales: fx(a.gross_sales, 4), totalCash: fx(a.cash_sales, 4),
      totalCard: fx(cardTotal, 4), totalRefund: fx(a.cash_refunds, 4), txnCount: a.txn_count, voidCount: a.void_count,
      cashExpected: fx(a.expected_cash, 4), cashCounted: fx(counted, 4), variance: fx(variance, 4),
      status: 'SIGNED', contentHash, htmlSnapshot: html,
    }).returning({ id: xzReports.id });
    const denomRows = Object.entries(denoms).filter(([, c]) => Number(c) > 0)
      .map(([d, c]) => ({ tenantId: sess.tenantId ?? null, reportId: Number(rep!.id), denomination: fx(Number(d), 2), count: Number(c), total: fx(Number(d) * Number(c), 4) }));
    if (denomRows.length) await db.insert(xzReportDenominations).values(denomRows);
    return { ...(await this.getXzReport(Number(rep!.id))), already: false };
  }

  async listXzReports(_user: JwtUser, limit = 50) {
    const db = this.db;
    const rows = await db.select().from(xzReports).orderBy(desc(xzReports.generatedAt), desc(xzReports.id)).limit(limit);
    return { reports: rows.map((r: any) => this.shapeXz(r)), count: rows.length };
  }

  async getXzReport(id: number) {
    const db = this.db;
    const [r] = await db.select().from(xzReports).where(eq(xzReports.id, id)).limit(1);
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Z-report not found', messageTh: 'ไม่พบรายงาน Z' });
    const dn = await db.select().from(xzReportDenominations).where(eq(xzReportDenominations.reportId, id)).orderBy(desc(xzReportDenominations.denomination));
    const denoms = dn.map((d: any) => ({ denomination: n(d.denomination), count: d.count, total: n(d.total) }));
    // re-verify the stored hash against the persisted totals → tamper flag for the auditor view.
    const recomputed = this.hashXz(Number(r.tillSessionId), n(r.grossSales), n(r.totalCash), n(r.totalCard), n(r.totalRefund), n(r.cashExpected), n(r.cashCounted), n(r.variance), denoms);
    return { ...this.shapeXz(r), denominations: denoms, hash_valid: recomputed === r.contentHash };
  }

  // deterministic content hash over a Z-report's persisted scalars + denomination rows (tamper-evidence).
  private hashXz(tillId: number, gross: number, cash: number, card: number, refund: number, expected: number, counted: number, variance: number, denoms: { denomination: number; count: number; total: number }[]) {
    const canonical = JSON.stringify({
      till: tillId, gross: fx(gross, 4), cash: fx(cash, 4), card: fx(card, 4), refund: fx(refund, 4),
      expected: fx(expected, 4), counted: fx(counted, 4), variance: fx(variance, 4),
      denoms: denoms.map((d) => `${fx(d.denomination, 2)}:${d.count}`).sort(),
    });
    return createHash('sha256').update(canonical).digest('hex');
  }

  private shapeXz(r: any) {
    return {
      id: Number(r.id), till_session_id: Number(r.tillSessionId), report_type: r.reportType, status: r.status,
      generated_by: r.generatedBy, generated_at: r.generatedAt, gross_sales: n(r.grossSales), total_cash: n(r.totalCash),
      total_card: n(r.totalCard), total_refund: n(r.totalRefund), txn_count: r.txnCount, void_count: r.voidCount,
      cash_expected: n(r.cashExpected), cash_counted: n(r.cashCounted), variance: n(r.variance), content_hash: r.contentHash,
    };
  }

  private renderZHtml(sessionNo: string, a: any, card: number, counted: number, variance: number, denoms: Record<string, number>, by: string, hash: string) {
    const rows = a.by_method.map((m: any) => `<tr><td>${m.method}</td><td style="text-align:right">${fx(m.amount, 2)}</td><td style="text-align:right">${m.count}</td></tr>`).join('');
    const dnRows = Object.entries(denoms).filter(([, c]) => Number(c) > 0).map(([d, c]) => `<tr><td>฿${d}</td><td style="text-align:right">${c}</td><td style="text-align:right">${fx(Number(d) * Number(c), 2)}</td></tr>`).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><title>Z-Report ${sessionNo}</title></head><body style="font-family:sans-serif">
<h2>รายงานปิดกะ (Z-Report)</h2><p>รอบ: <b>${sessionNo}</b> · ลงนามโดย: ${by}</p>
<table><tr><td>ยอดขายรวม</td><td style="text-align:right">${fx(a.gross_sales, 2)}</td></tr>
<tr><td>เงินสด</td><td style="text-align:right">${fx(a.cash_sales, 2)}</td></tr>
<tr><td>บัตร/อื่นๆ</td><td style="text-align:right">${fx(card, 2)}</td></tr>
<tr><td>เงินคืน</td><td style="text-align:right">${fx(a.cash_refunds, 2)}</td></tr>
<tr><td>คาดว่าในลิ้นชัก</td><td style="text-align:right">${fx(a.expected_cash, 2)}</td></tr>
<tr><td>นับจริง</td><td style="text-align:right">${fx(counted, 2)}</td></tr>
<tr><td>ผลต่าง</td><td style="text-align:right">${fx(variance, 2)}</td></tr></table>
<h3>ตามวิธีชำระ</h3><table><tr><th>วิธี</th><th>ยอด</th><th>จำนวน</th></tr>${rows}</table>
${dnRows ? `<h3>นับเงินตามหน่วย</h3><table><tr><th>หน่วย</th><th>จำนวน</th><th>รวม</th></tr>${dnRows}</table>` : ''}
<p style="font-size:11px;color:#666">content-hash: ${hash}</p></body></html>`;
  }

  // GET /api/payments?sale_no= — all tenders attached to a sale.
  async listPaymentsForSale(saleNo: string) {
    const db = this.db;
    const rows = await db.select({
      payment_no: payments.paymentNo, sale_no: payments.saleNo, method: payments.method, amount: payments.amount,
      currency: payments.currency, gateway: payments.gateway, gateway_ref: payments.gatewayRef, status: payments.status,
      captured_at: payments.capturedAt, created_at: payments.createdAt,
    }).from(payments).where(eq(payments.saleNo, saleNo)).orderBy(desc(payments.createdAt));
    const out = rows.map((r: any) => ({ ...r, amount: n(r.amount) }));
    return { sale_no: saleNo, payments: out, count: out.length, total_captured: out.filter((r: any) => r.status === 'Captured').reduce((a: number, r: any) => a + r.amount, 0) };
  }
}
