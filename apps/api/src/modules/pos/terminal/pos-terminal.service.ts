import { Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { eq, and, desc, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { paymentTerminals, paymentIntents, settlementBatches, settlementLines, pspWebhookEvents } from '../../../database/schema';
import { Optional } from '@nestjs/common';
import { DocNumberService } from '../../../common/doc-number.service';
import { getProvider } from './providers';
import { PaymentService } from '../../payments/payments.service';
import { RealtimeScope } from '../../restaurant/realtime.scope';
import { n, ymd } from '../../../database/queries';
import type { JwtUser } from '../../../common/decorators';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

export interface ChargeDto { terminal_code?: string; sale_no?: string; amount: number; tip?: number; type?: 'sale' | 'preauth'; currency?: string; token?: string; record_tender?: boolean }
export interface SettlementReportDto { rows: { provider_ref: string; amount: number; fee?: number }[] }

// Card terminal abstraction: charge / pre-auth / capture / void / refund + settlement.
// Providers are pluggable; only 'mock' is wired (real Opn/2C2P/GBPrime drop in via chargeViaProvider).
// This is the card-acceptance/settlement ledger — GL tender is still posted by PaymentService at sale time.
@Injectable()
export class PosTerminalService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly scope: RealtimeScope,
    @Optional() private readonly payments?: PaymentService,  // wiring: record a card tender on capture
  ) {}

  // ── Terminals ─────────────────────────────────────────────────────────────
  async registerTerminal(dto: { terminal_code: string; name?: string; provider?: string }, user: JwtUser) {
    const db = this.db;
    await db.insert(paymentTerminals).values({ tenantId: user.tenantId ?? null, terminalCode: dto.terminal_code, name: dto.name ?? null, provider: dto.provider ?? 'mock', status: 'active', createdBy: user.username });
    return { terminal_code: dto.terminal_code, provider: dto.provider ?? 'mock', status: 'active' };
  }
  async listTerminals() {
    const db = this.db;
    const rows = await db.select().from(paymentTerminals).orderBy(desc(paymentTerminals.id));
    return { terminals: rows.map((r: any) => ({ terminal_code: r.terminalCode, name: r.name, provider: r.provider, status: r.status, last_seen_at: r.lastSeenAt })), count: rows.length };
  }

  // ── Charge / pre-auth ──────────────────────────────────────────────────────
  async charge(dto: ChargeDto, user: JwtUser) {
    if (!(dto.amount > 0)) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'amount must be > 0', messageTh: 'จำนวนเงินไม่ถูกต้อง' });
    const db = this.db;
    let provider = 'mock';
    if (dto.terminal_code) {
      const [t] = await db.select().from(paymentTerminals).where(eq(paymentTerminals.terminalCode, dto.terminal_code)).limit(1);
      if (t) provider = t.provider ?? 'mock';
    }
    const type = dto.type ?? 'sale';
    // C5 — tip-on-terminal: the cardholder's tip rides the same charge (total = amount + tip) and is
    // recorded on the intent so settlement/reporting can split it back out.
    const tip = round2(Math.max(0, n(dto.tip)));
    const total = round2(round2(dto.amount) + tip);
    const intentNo = await this.docNo.nextDaily('PTI');
    const { ref, status } = await getProvider(provider).charge({ amount: total, currency: dto.currency ?? 'THB', type, token: dto.token, intentNo });
    const captured = status === 'Captured';
    await db.insert(paymentIntents).values({
      tenantId: user.tenantId ?? null, intentNo, saleNo: dto.sale_no ?? null, terminalCode: dto.terminal_code ?? null,
      provider, providerRef: ref, type, amount: String(total), capturedAmount: captured ? String(total) : '0', tipAmount: String(tip),
      currency: dto.currency ?? 'THB', status, createdBy: user.username, capturedAt: captured ? new Date() : null,
    });
    // wiring (opt-in): on a captured card charge tied to a sale, record the tender so closeTill/X-Z
    // reports see card sales. recordTender posts no GL itself (the sale flow owns revenue GL).
    let paymentNo: string | null = null;
    if (captured && dto.sale_no && dto.record_tender && this.payments) {
      try {
        const openTill = user.tenantId != null ? await this.payments.currentOpenTill(user.tenantId) : null;
        const tender = await this.payments.recordTender({ sale_no: dto.sale_no, tenant_id: user.tenantId ?? undefined, method: 'Card', amount: total, currency: dto.currency ?? 'THB', gateway: 'mock', till_session_id: openTill?.id }, user);
        paymentNo = tender.payment_no;
      } catch { /* tender recording best-effort */ }
    }
    return { intent_no: intentNo, provider, provider_ref: ref, status, type, amount: total, tip, payment_no: paymentNo };
  }

  async capture(intentNo: string, amount: number | undefined, user: JwtUser, tip?: number) {
    const db = this.db;
    return db.transaction(async (tx: any) => {
      const [i] = await tx.select().from(paymentIntents).where(eq(paymentIntents.intentNo, intentNo)).limit(1).for('update');
      if (!i) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Intent not found', messageTh: 'ไม่พบรายการชำระ' });
      if (i.status !== 'Authorized') throw new BadRequestException({ code: 'NOT_AUTHORIZED', message: `Cannot capture a ${i.status} intent`, messageTh: 'จับยอดไม่ได้' });
      const base = round2(amount ?? n(i.amount));
      // C5 — the classic bar-tab tip adjustment: the OVER_CAPTURE guard applies to the pre-authorised BASE;
      // the tip is added on top (acquirers allow a capture above the auth by the gratuity).
      const capTip = round2(Math.max(0, n(tip)));
      if (base > n(i.amount) + 0.001) throw new BadRequestException({ code: 'OVER_CAPTURE', message: 'Capture exceeds authorized amount', messageTh: 'จับยอดเกินวงเงิน' });
      const cap = round2(base + capTip);
      await getProvider(i.provider).capture(i.providerRef, cap);
      await tx.update(paymentIntents).set({ status: 'Captured', capturedAmount: String(cap), tipAmount: String(round2(n(i.tipAmount) + capTip)), capturedAt: new Date() }).where(eq(paymentIntents.id, i.id));
      void user;
      return { intent_no: intentNo, status: 'Captured', captured_amount: cap, tip: capTip };
    });
  }

  async voidIntent(intentNo: string) {
    const db = this.db;
    return db.transaction(async (tx: any) => {
      const [i] = await tx.select().from(paymentIntents).where(eq(paymentIntents.intentNo, intentNo)).limit(1).for('update');
      if (!i) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Intent not found', messageTh: 'ไม่พบรายการชำระ' });
      if (i.status === 'Captured' || i.status === 'Refunded') throw new BadRequestException({ code: 'CANNOT_VOID', message: `Cannot void a ${i.status} intent — refund instead`, messageTh: 'ยกเลิกไม่ได้ ใช้คืนเงินแทน' });
      await getProvider(i.provider).voidCharge(i.providerRef);
      await tx.update(paymentIntents).set({ status: 'Voided' }).where(eq(paymentIntents.id, i.id));
      return { intent_no: intentNo, status: 'Voided' };
    });
  }

  async refundIntent(intentNo: string, amount: number) {
    const db = this.db;
    return db.transaction(async (tx: any) => {
      const [i] = await tx.select().from(paymentIntents).where(eq(paymentIntents.intentNo, intentNo)).limit(1).for('update');
      if (!i) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Intent not found', messageTh: 'ไม่พบรายการชำระ' });
      if (i.status !== 'Captured') throw new BadRequestException({ code: 'NOT_CAPTURED', message: 'Only captured intents can be refunded', messageTh: 'คืนเงินได้เฉพาะรายการที่จับยอดแล้ว' });
      if (round2(amount) > n(i.capturedAmount) + 0.001) throw new BadRequestException({ code: 'OVER_REFUND', message: 'Refund exceeds captured amount', messageTh: 'คืนเงินเกินยอดที่จับ' });
      await getProvider(i.provider).refund(i.providerRef, round2(amount));
      const remaining = round2(n(i.capturedAmount) - round2(amount));
      await tx.update(paymentIntents).set({ status: remaining <= 0.001 ? 'Refunded' : 'Captured', capturedAmount: String(remaining) }).where(eq(paymentIntents.id, i.id));
      return { intent_no: intentNo, refunded: round2(amount), remaining };
    });
  }

  // PSP webhook (idempotent on provider_ref). Public — derive nothing from auth.
  // PSP webhook — runs under @NoTx (public, no JWT). Resolve the intent (+ its tenant) via a controlled
  // bypass read on the globally-unique providerRef, then flip status RLS-scoped to THAT tenant, so a
  // webhook can never mutate another tenant's payment even if the signature secret were compromised.
  async webhook(provider: string, providerRef: string, status: string, eventId?: string) {
    const intent = await this.scope.bypassQuery(async () => {
      const db = this.db;
      const [i] = await db.select().from(paymentIntents).where(and(eq(paymentIntents.provider, provider), eq(paymentIntents.providerRef, providerRef))).limit(1);
      return i ?? null;
    });
    if (!intent) return { ok: true, note: 'no matching intent' }; // idempotent / unknown → ack
    const doUpdate = async () => {
      const db = this.db;
      // C5 — PSP EVENT-ID idempotency: with an event_id, the (provider, event_id) unique key admits an
      // event exactly once — a redelivered event (possibly carrying a stale/older status) acks as
      // duplicate_event and can never re-process/flap the intent. No event_id → legacy status-diff path.
      if (eventId) {
        const dedup = await db.insert(pspWebhookEvents)
          .values({ tenantId: intent.tenantId ?? null, provider, eventId, providerRef, status, outcome: 'processing' })
          .onConflictDoNothing().returning({ id: pspWebhookEvents.id });
        if (!dedup.length) return { ok: true, note: 'duplicate_event', event_id: eventId };
      }
      // Trust the PSP API, not the webhook payload: re-fetch authoritative status (mock returns null → use payload).
      const verified = await getProvider(provider).verifyWebhook(providerRef);
      const finalStatus = verified ?? status;
      const outcome = intent.status === finalStatus ? 'already' : `-> ${finalStatus}`;
      if (eventId) await db.update(pspWebhookEvents).set({ outcome }).where(and(eq(pspWebhookEvents.provider, provider), eq(pspWebhookEvents.eventId, eventId)));
      if (intent.status === finalStatus) return { ok: true, note: 'already' };
      const set: any = { status: finalStatus };
      if (finalStatus === 'Captured') { set.capturedAmount = intent.amount; set.capturedAt = new Date(); }
      await db.update(paymentIntents).set(set).where(eq(paymentIntents.id, intent.id));
      return { ok: true, intent_no: intent.intentNo, status };
    };
    // Scope to the intent's tenant; a legacy null-tenant intent falls back to a bypass update.
    return intent.tenantId != null ? this.scope.run(Number(intent.tenantId), doUpdate) : this.scope.bypassQuery(doUpdate);
  }

  // ── Settlement ─────────────────────────────────────────────────────────────
  // Batch all unsettled Captured intents for the day, compute fees/net, mark Settled.
  async settle(dto: { fee_pct?: number; date?: string }, user: JwtUser) {
    const db = this.db;
    const open = await db.select().from(paymentIntents).where(and(eq(paymentIntents.status, 'Captured'), isNull(paymentIntents.settlementBatchNo)));
    if (!open.length) throw new BadRequestException({ code: 'NOTHING_TO_SETTLE', message: 'No captured intents to settle', messageTh: 'ไม่มีรายการให้สรุปยอด' });
    const gross = round2(open.reduce((a: number, r: any) => a + n(r.capturedAmount), 0));
    const fees = round2(gross * (dto.fee_pct ?? 0) / 100);
    const batchNo = await this.docNo.nextDaily('STL');
    await db.transaction(async (tx: any) => {
      await tx.insert(settlementBatches).values({ tenantId: user.tenantId ?? null, batchNo, provider: open[0]!.provider, batchDate: dto.date ?? ymd(), gross: String(gross), fees: String(fees), net: String(round2(gross - fees)), txnCount: open.length, status: 'Settled' });
      for (const i of open) await tx.update(paymentIntents).set({ settlementBatchNo: batchNo }).where(eq(paymentIntents.id, i.id));
    });
    return { batch_no: batchNo, gross, fees, net: round2(gross - fees), txn_count: open.length, status: 'Settled' };
  }

  async listSettlements(limit = 50) {
    const db = this.db;
    const rows = await db.select().from(settlementBatches).orderBy(desc(settlementBatches.id)).limit(limit);
    return { batches: rows.map((r: any) => ({ batch_no: r.batchNo, provider: r.provider, batch_date: r.batchDate, gross: n(r.gross), fees: n(r.fees), net: n(r.net), txn_count: r.txnCount, status: r.status, reconciled_amount: r.reconciledAmount != null ? n(r.reconciledAmount) : null, discrepancy_count: r.discrepancyCount ?? 0 })), count: rows.length };
  }

  async reconcile(batchNo: string, user: JwtUser) {
    const db = this.db;
    const [b] = await db.select().from(settlementBatches).where(eq(settlementBatches.batchNo, batchNo)).limit(1);
    if (!b) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Batch not found', messageTh: 'ไม่พบรอบสรุปยอด' });
    await db.update(settlementBatches).set({ status: 'Reconciled', reconciledBy: user.username, reconciledAt: new Date() }).where(eq(settlementBatches.id, b.id));
    return { batch_no: batchNo, status: 'Reconciled' };
  }

  // ── C5 — acquirer settlement-report reconciliation (a real per-intent match, not a status flip) ──
  // Import the acquirer's settlement report for a batch; each row is matched by provider_ref against the
  // batch's intents: matched (amount agrees within 1 satang) · amount_mismatch · missing_intent (the
  // acquirer settled money we have no intent for) · unreported_intent (a batched intent the report omits).
  // Zero discrepancies ⇒ the batch flips Reconciled with the matched total; otherwise it stays Settled and
  // carries discrepancy_count — the exceptions worklist. Re-import replaces the previous line set.
  async importSettlementReport(batchNo: string, dto: SettlementReportDto, user: JwtUser) {
    const db = this.db;
    const [b] = await db.select().from(settlementBatches).where(eq(settlementBatches.batchNo, batchNo)).limit(1);
    if (!b) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Batch not found', messageTh: 'ไม่พบรอบสรุปยอด' });
    if (!dto.rows?.length) throw new BadRequestException({ code: 'EMPTY_REPORT', message: 'The settlement report has no rows', messageTh: 'รายงานสรุปยอดว่างเปล่า' });
    const intents = await db.select().from(paymentIntents).where(eq(paymentIntents.settlementBatchNo, batchNo));
    const byRef = new Map<string, any>(intents.map((i: any) => [String(i.providerRef), i]));
    const seen = new Set<string>();
    const lines: any[] = [];
    let matchedAmount = 0;
    for (const r of dto.rows) {
      const ref = String(r.provider_ref);
      const i = byRef.get(ref);
      if (!i) { lines.push({ providerRef: ref, intentNo: null, amount: r.amount, fee: r.fee ?? 0, matchStatus: 'missing_intent', note: 'settled by the acquirer but no intent in this batch' }); continue; }
      seen.add(ref);
      if (Math.abs(round2(r.amount) - n(i.capturedAmount)) <= 0.01) {
        matchedAmount = round2(matchedAmount + round2(r.amount));
        lines.push({ providerRef: ref, intentNo: i.intentNo, amount: r.amount, fee: r.fee ?? 0, matchStatus: 'matched', note: null });
      } else {
        lines.push({ providerRef: ref, intentNo: i.intentNo, amount: r.amount, fee: r.fee ?? 0, matchStatus: 'amount_mismatch', note: `report ${round2(r.amount)} vs captured ${n(i.capturedAmount)}` });
      }
    }
    for (const i of intents) {
      if (!seen.has(String(i.providerRef))) lines.push({ providerRef: i.providerRef, intentNo: i.intentNo, amount: 0, fee: 0, matchStatus: 'unreported_intent', note: `captured ${n(i.capturedAmount)} not in the acquirer report` });
    }
    const discrepancies = lines.filter((l) => l.matchStatus !== 'matched').length;
    await db.transaction(async (tx: any) => {
      await tx.delete(settlementLines).where(eq(settlementLines.batchNo, batchNo)); // re-import replaces
      for (const l of lines) await tx.insert(settlementLines).values({ tenantId: user.tenantId ?? null, batchNo, ...l, amount: String(round2(l.amount)), fee: String(round2(l.fee)) });
      await tx.update(settlementBatches).set({
        reconciledAmount: String(matchedAmount), discrepancyCount: discrepancies,
        ...(discrepancies === 0 ? { status: 'Reconciled', reconciledBy: user.username, reconciledAt: new Date() } : {}),
      }).where(eq(settlementBatches.id, b.id));
    });
    return {
      batch_no: batchNo, rows: lines.length, matched: lines.filter((l) => l.matchStatus === 'matched').length,
      discrepancies, reconciled_amount: matchedAmount, status: discrepancies === 0 ? 'Reconciled' : b.status,
      lines: lines.map((l) => ({ provider_ref: l.providerRef, intent_no: l.intentNo, amount: round2(l.amount), fee: round2(l.fee), match_status: l.matchStatus, note: l.note })),
    };
  }

  async listSettlementLines(batchNo: string) {
    const db = this.db;
    const rows = await db.select().from(settlementLines).where(eq(settlementLines.batchNo, batchNo)).orderBy(settlementLines.id);
    return { batch_no: batchNo, lines: rows.map((r: any) => ({ provider_ref: r.providerRef, intent_no: r.intentNo, amount: n(r.amount), fee: n(r.fee), match_status: r.matchStatus, note: r.note })), count: rows.length };
  }

  async listIntents(saleNo?: string, limit = 100) {
    const db = this.db;
    const where = saleNo ? eq(paymentIntents.saleNo, saleNo) : undefined;
    const rows = await db.select().from(paymentIntents).where(where).orderBy(desc(paymentIntents.id)).limit(limit);
    return { intents: rows.map((r: any) => ({ intent_no: r.intentNo, sale_no: r.saleNo, provider: r.provider, type: r.type, amount: n(r.amount), captured_amount: n(r.capturedAmount), tip: n(r.tipAmount), status: r.status, settlement_batch_no: r.settlementBatchNo })), count: rows.length };
  }
}
