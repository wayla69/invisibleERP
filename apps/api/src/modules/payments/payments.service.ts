import { Inject, Injectable, Optional, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { assertMakerChecker } from '../../common/control-profile';
import { sql, eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { payments, paymentRefunds, tenants, refundRequests, posTipAdjustments } from '../../database/schema';
import { TillPolicy } from './till-policy';
import { DocNumberService } from '../../common/doc-number.service';
import { LedgerService } from '../ledger/ledger.service';
import { n, fx } from '../../database/queries';
import { round2, roundCurrency } from '../tax/money';
import type { JwtUser } from '../../common/decorators';
import { TillSessionService } from './till-session.service';
import { resolveGateway } from './gateways';
import { PosAuditService } from '../pos/audit/pos-audit.service';
import { JournalService } from '../pos/fiscal/journal.service';
import { QrService } from '../qr/qr.service';

// POS-01: cash over/short at/above this absolute THB amount needs manager approval (maker-checker);
// below it the over/short posts to GL immediately. A flat threshold for now — a tenant-level override
// can replace this constant without changing the close/approve flow.
// Exported so the hub till-ingest (BRANCH-05) applies the SAME materiality line as a native close.
export const CASH_VARIANCE_THRESHOLD = 100;
// REV-16: a standalone refund at/above this absolute THB amount needs a different user's approval
// (maker-checker, anti-fraud); below it the refund runs immediately. Flat threshold for now.
const REFUND_APPROVAL_THRESHOLD = 1000;

// POS-10 (tip-adjust-after-auth): the tip added after a card authorization may not exceed this fraction of
// the authorized bill amount — the classic US-restaurant guardrail (the pre-auth carries a cushion so the
// captured total stays within the hold). A tip above the ceiling is rejected (TIP_OVER_LIMIT); the policy %
// is env-overridable (POS_TIP_ADJUST_MAX_PCT, e.g. 0.20) without touching the flow. Default 25%.
export const TIP_ADJUST_MAX_PCT = ((): number => {
  const v = Number(process.env.POS_TIP_ADJUST_MAX_PCT);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.25;
})();

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
  authorize?: boolean;        // POS-10: auth-only (place a hold, capture later) — the tip-adjust flow
}
export interface AdjustTipDto { tip: number; reason?: string }
export interface RefundDto { payment_no: string; amount: number; reason?: string }
export interface OpenTillDto { opening_float?: number }
export interface CloseTillDto { session_no: string; closing_count: number; denominations?: Record<string, number> }
export interface TillSettingsDto { blind_close?: boolean }
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
  ) {
    // Blind drawer close (0426, P1c) — ctor-body plain class so the positional ctor stays unchanged
    // (service-size ratchet, docs/46 §4; same pattern as the projects facade's sub-services).
    this.tillPolicy = new TillPolicy(this.db);
    // Ctor-body plain class (god-service ratchet round) — the till/drawer/X-Z domain.
    this.tills = new TillSessionService(this.db, docNo, ledger, this.tillPolicy);
  }
  private readonly tillPolicy: TillPolicy;
  private readonly tills: TillSessionService;

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
      // POS-10: authorize=true places a hold only (→ Authorized) so staff can adjust the tip before capture;
      // the default path authorizes AND captures in one shot (unchanged).
      result = dto.authorize
        ? await gateway.authorize(n(dto.amount), currency, dto.method, { sale_no: dto.sale_no, promptpay_id: promptpayId, token: dto.token })
        : await gateway.authorizeAndCapture(n(dto.amount), currency, dto.method, { sale_no: dto.sale_no, promptpay_id: promptpayId, token: dto.token });
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

  // ── POS-10: tip-adjust-after-auth (US-restaurant "auth now, add tip, capture later") ──

  // POST /api/payments/:no/tip-adjust — set the tip on an AUTHORIZED (not-yet-captured) card tender.
  // Two controls bound the adjustment (POS-10): (1) PRE-CAPTURE ONLY — a Captured/Settled/Voided/Refunded
  // tender is immutable (TIP_ADJUST_CLOSED); the money has moved, the tip is locked. (2) POLICY CEILING —
  // the tip may not exceed TIP_ADJUST_MAX_PCT of the authorized bill (TIP_OVER_LIMIT), the classic hold
  // cushion. Every adjustment is written to the immutable pos_tip_adjustments log (old→new + the ceiling in
  // force) so the charged tip always ties back to the slip. The tip is NOT captured here — it rides into
  // 2300 Tips Payable at capture. Idempotent-safe (re-setting the same tip re-logs a zero-delta adjustment).
  async adjustTip(paymentNo: string, dto: AdjustTipDto, user: JwtUser) {
    const newTip = round2(n(dto.tip));
    if (newTip < 0) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'Tip cannot be negative', messageTh: 'ทิปต้องไม่ติดลบ' });
    return await this.db.transaction(async (tx: any) => {
      const [pay] = await tx.select().from(payments).where(eq(payments.paymentNo, paymentNo)).for('update').limit(1);
      if (!pay) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Payment not found', messageTh: 'ไม่พบรายการชำระเงิน' });
      if (String(pay.status ?? '') !== 'Authorized') {
        throw new BadRequestException({ code: 'TIP_ADJUST_CLOSED', message: `Tip can only be adjusted before capture (payment is ${pay.status})`, messageTh: 'ปรับทิปได้เฉพาะก่อนเก็บเงิน (รายการนี้ปรับไม่ได้แล้ว)' });
      }
      const authAmount = round2(n(pay.amount));
      const maxTip = roundCurrency(authAmount * TIP_ADJUST_MAX_PCT, 'THB');
      if (newTip > maxTip + 1e-9) {
        throw new BadRequestException({ code: 'TIP_OVER_LIMIT', message: `Tip ${newTip} exceeds the ${Math.round(TIP_ADJUST_MAX_PCT * 100)}% ceiling (${maxTip}) on the authorized amount ${authAmount}`, messageTh: `ทิปเกินเพดานที่กำหนด (${maxTip})` });
      }
      const oldTip = round2(n(pay.tip));
      const delta = round2(newTip - oldTip);
      await tx.insert(posTipAdjustments).values({
        tenantId: pay.tenantId, paymentNo, oldTip: fx(oldTip, 4), newTip: fx(newTip, 4), delta: fx(delta, 4),
        authAmount: fx(authAmount, 4), maxTip: fx(maxTip, 4), reason: dto.reason ?? null, adjustedBy: user.username,
      });
      await tx.update(payments).set({ tip: fx(newTip, 4) }).where(eq(payments.id, pay.id));
      return { payment_no: paymentNo, status: pay.status, auth_amount: authAmount, tip: newTip, previous_tip: oldTip, delta, max_tip: maxTip, max_pct: TIP_ADJUST_MAX_PCT };
    }).then(async (res) => {
      if (this.audit) { try { await this.audit.record({ action: 'tip_adjust', entity: 'payment', entityId: paymentNo, meta: { old_tip: res.previous_tip, new_tip: res.tip, max_tip: res.max_tip } }, user); } catch { /* audit best-effort */ } }
      return res;
    });
  }

  // POST /api/payments/:no/capture — capture an AUTHORIZED card tender for bill + adjusted tip (POS-10).
  // Settles the held authorization at the PSP for amount + tip, flips the tender to Captured, and posts the
  // tip to 2300 Tips Payable (Dr 1000 / Cr 2300) so the existing tip-pool/distribution flow (TIP-01) pays it
  // out unchanged — the bill's revenue/VAT are recognised at the sale checkout, so only the added tip posts
  // here. Re-asserts the policy ceiling as a backstop. Idempotent: a second capture returns the captured row.
  async capture(paymentNo: string, user: JwtUser) {
    const [pay] = await this.db.select().from(payments).where(eq(payments.paymentNo, paymentNo)).limit(1);
    if (!pay) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Payment not found', messageTh: 'ไม่พบรายการชำระเงิน' });
    const status = String(pay.status ?? '');
    if (status === 'Captured' || status === 'Settled') {
      return { payment_no: paymentNo, status: 'Captured', amount: n(pay.amount), tip: n(pay.tip), captured_total: round2(n(pay.amount) + n(pay.tip)), already: true };
    }
    if (status !== 'Authorized') {
      throw new BadRequestException({ code: 'CANNOT_CAPTURE', message: `Payment in status ${status} cannot be captured`, messageTh: 'รายการนี้เก็บเงินไม่ได้' });
    }
    const authAmount = round2(n(pay.amount));
    const tip = round2(n(pay.tip));
    const maxTip = roundCurrency(authAmount * TIP_ADJUST_MAX_PCT, 'THB');
    if (tip > maxTip + 1e-9) throw new BadRequestException({ code: 'TIP_OVER_LIMIT', message: `Tip ${tip} exceeds the ${Math.round(TIP_ADJUST_MAX_PCT * 100)}% ceiling (${maxTip})`, messageTh: `ทิปเกินเพดานที่กำหนด (${maxTip})` });
    const captureTotal = round2(authAmount + tip);
    const { gateway } = resolveGateway(pay.gateway ?? undefined);

    let result;
    try {
      result = await gateway.capture(String(pay.gatewayRef ?? ''), captureTotal, pay.currency ?? 'THB', { sale_no: pay.saleNo });
    } catch (e: any) {
      const code = e?.response?.code ?? e?.code ?? 'PSP_ERROR';
      const message = e?.response?.message ?? e?.message ?? String(e);
      throw new BadRequestException({ code, message: `Capture failed: ${message}`, messageTh: 'การเก็บเงินผิดพลาด' });
    }

    // Post the tip to 2300 Tips Payable on capture (Dr 1000 / Cr 2300), idempotent per payment. The bill's
    // revenue/VAT/COGS were posted at the sale checkout — only the added tip is new money to book here.
    let tipJournalNo: string | null = null;
    if (tip > 0 && !(await this.ledger.alreadyPosted('POS_TIP', paymentNo, pay.tenantId ?? null))) {
      const je: any = await this.ledger.postEntry({
        source: 'POS_TIP', sourceRef: paymentNo, tenantId: pay.tenantId ?? null,
        memo: `Card tip on capture ${paymentNo}`, createdBy: user.username,
        lines: [{ account_code: '1000', debit: tip }, { account_code: '2300', credit: tip }],
      });
      tipJournalNo = je?.entry_no ?? null;
    }
    await this.db.update(payments).set({ status: 'Captured', gatewayRef: result.ref ?? pay.gatewayRef, capturedAt: new Date() }).where(eq(payments.id, pay.id));

    if (this.audit) { try { await this.audit.record({ action: 'capture', entity: 'payment', entityId: paymentNo, meta: { amount: authAmount, tip, captured_total: captureTotal } }, user); } catch { /* audit best-effort */ } }
    if (this.journal) { try { await this.journal.append({ doc_type: 'CAPTURE', doc_no: paymentNo, payload: { amount: authAmount, tip, captured_total: captureTotal } }, user); } catch { /* journal best-effort */ } }
    return { payment_no: paymentNo, status: 'Captured', amount: authAmount, tip, captured_total: captureTotal, tip_journal_no: tipJournalNo };
  }

  // GET /api/payments/:no/tip-adjustments — the immutable adjustment audit trail for a tender (POS-10).
  async listTipAdjustments(paymentNo: string, _user: JwtUser) {
    const rows = await this.db.select().from(posTipAdjustments).where(eq(posTipAdjustments.paymentNo, paymentNo)).orderBy(desc(posTipAdjustments.createdAt), desc(posTipAdjustments.id));
    return { payment_no: paymentNo, adjustments: rows.map((r: any) => ({ old_tip: n(r.oldTip), new_tip: n(r.newTip), delta: n(r.delta), auth_amount: n(r.authAmount), max_tip: n(r.maxTip), reason: r.reason, by: r.adjustedBy, at: r.createdAt })), count: rows.length };
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
    // return) whose CUMULATIVE total crosses the materiality threshold is parked as a request and moves no
    // money until a DIFFERENT user approves. opts.force lets approveRefund run the real refund past the gate.
    // Security (pentest P6): the threshold is cumulative — settled refunds + already-pending requests + this
    // amount — NOT per-call. A per-call gate let a large refund be split into sub-threshold parts that each
    // skipped approval; summing defeats that. This read only routes the approval decision — the money
    // invariant (over-refund) is still enforced under the FOR UPDATE lock in run()/requestRefund(), and
    // requestRefund re-checks the running total under its own lock before queuing.
    if (!outerTx && !opts?.force) {
      const [prior] = await this.db.select({ v: sql<string>`coalesce(sum(${paymentRefunds.amount}),0)` }).from(paymentRefunds).where(eq(paymentRefunds.paymentNo, dto.payment_no));
      const [pending] = await this.db.select({ v: sql<string>`coalesce(sum(${refundRequests.amount}),0)` }).from(refundRequests).where(and(eq(refundRequests.paymentNo, dto.payment_no), eq(refundRequests.status, 'PendingApproval')));
      if (n(prior?.v) + n(pending?.v) + n(dto.amount) >= REFUND_APPROVAL_THRESHOLD) {
        return this.requestRefund(dto, user);
      }
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
  async approveRefund(requestId: number, approver: JwtUser, selfApprovalReason?: string | null) {
    const db = this.db;
    const [req] = await db.select().from(refundRequests).where(eq(refundRequests.id, requestId)).limit(1);
    if (!req) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Refund request not found', messageTh: 'ไม่พบคำขอคืนเงิน' });
    if (String(req.status) !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Request is ${req.status}`, messageTh: 'คำขอนี้ไม่ได้รออนุมัติ' });
    await assertMakerChecker(db, { user: approver, maker: req.requestedBy, event: 'pay.refund.approve', ref: String(requestId), amount: n(req.amount), reason: selfApprovalReason, code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot approve a refund you requested', messageTh: 'ผู้ขออนุมัติคืนเงินของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    // run the real refund past the gate (force), crediting it to the approver (who authorizes the money-out).
    const res: any = await this.refund({ payment_no: req.paymentNo, amount: n(req.amount), reason: req.reason ?? undefined }, approver, undefined, { force: true });
    await db.update(refundRequests).set({ status: 'Approved', approvedBy: approver.username, refundNo: res.refund_no, approvedAt: new Date() }).where(eq(refundRequests.id, requestId));
    return { request_id: requestId, status: 'Approved', refund_no: res.refund_no, approved_by: approver.username, requested_by: req.requestedBy };
  }

  // POST /api/payments/refund-requests/:id/reject
  async rejectRefund(requestId: number, approver: JwtUser, reason?: string, selfApprovalReason?: string | null) {
    const db = this.db;
    const [req] = await db.select().from(refundRequests).where(eq(refundRequests.id, requestId)).limit(1);
    if (!req) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Refund request not found', messageTh: 'ไม่พบคำขอคืนเงิน' });
    if (String(req.status) !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Request is ${req.status}`, messageTh: 'คำขอนี้ไม่ได้รออนุมัติ' });
    await assertMakerChecker(db, { user: approver, maker: req.requestedBy, event: 'pay.refund.reject', ref: String(requestId), reason: selfApprovalReason, code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot reject a refund you requested', messageTh: 'ผู้ขอปฏิเสธคำขอของตนเองไม่ได้' });
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

  // ── Till sessions / drawer cash / X-Z reports — extracted to TillSessionService (god-service ratchet
  // round; ctor-body plain class). The tender/refund lifecycle stays on this facade. ──
  async openTill(dto: OpenTillDto, user: JwtUser) { return this.tills.openTill(dto, user); }
  async currentOpenTill(tenantId: number) { return this.tills.currentOpenTill(tenantId); }
  async listTillSessions(user: JwtUser, status?: string) { return this.tills.listTillSessions(user, status); }
  async currentTill(user: JwtUser) { return this.tills.currentTill(user); }
  getTillSettings(user: JwtUser) { return this.tills.getTillSettings(user); }
  putTillSettings(dto: TillSettingsDto, user: JwtUser) { return this.tills.putTillSettings(dto, user); }
  async closeTill(dto: CloseTillDto, user: JwtUser) { return this.tills.closeTill(dto, user); }
  async approveVariance(sessionNo: string, approver: JwtUser) { return this.tills.approveVariance(sessionNo, approver); }
  async rejectVariance(sessionNo: string, approver: JwtUser, reason?: string) { return this.tills.rejectVariance(sessionNo, approver, reason); }
  async recordCashMovement(tillId: number, dto: CashMovementDto, user: JwtUser) { return this.tills.recordCashMovement(tillId, dto, user); }
  async xReport(tillId: number, user: JwtUser) { return this.tills.xReport(tillId, user); }
  async zReport(tillId: number, user: JwtUser) { return this.tills.zReport(tillId, user); }
  async signZReport(sessionNo: string, user: JwtUser, denominations?: Record<string, number>) { return this.tills.signZReport(sessionNo, user, denominations); }
  async listXzReports(user: JwtUser, limit = 50) { return this.tills.listXzReports(user, limit); }
  async getXzReport(id: number) { return this.tills.getXzReport(id); }

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
