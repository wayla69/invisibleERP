import { Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { eq, and, desc, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { paymentTerminals, paymentIntents, settlementBatches } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { n, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

export interface ChargeDto { terminal_code?: string; sale_no?: string; amount: number; type?: 'sale' | 'preauth'; currency?: string }

// Card terminal abstraction: charge / pre-auth / capture / void / refund + settlement.
// Providers are pluggable; only 'mock' is wired (real Opn/2C2P/GBPrime drop in via chargeViaProvider).
// This is the card-acceptance/settlement ledger — GL tender is still posted by PaymentService at sale time.
@Injectable()
export class PosTerminalService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, private readonly docNo: DocNumberService) {}

  // ── Provider adapter ──────────────────────────────────────────────────────
  private chargeViaProvider(provider: string, _amount: number, type: 'sale' | 'preauth'): { ref: string; status: string } {
    const ref = `${provider}_${Math.abs(hash(`${provider}:${_amount}:${type}:${ymd()}`))}`;
    if (provider === 'mock') return { ref, status: type === 'preauth' ? 'Authorized' : 'Captured' };
    // Real PSPs (omise/2c2p/gbprime) plug in here once merchant creds exist.
    throw new BadRequestException({ code: 'PROVIDER_NOT_CONFIGURED', message: `Provider ${provider} not configured`, messageTh: 'ยังไม่ได้ตั้งค่าผู้ให้บริการชำระเงิน' });
  }

  // ── Terminals ─────────────────────────────────────────────────────────────
  async registerTerminal(dto: { terminal_code: string; name?: string; provider?: string }, user: JwtUser) {
    const db = this.db as any;
    await db.insert(paymentTerminals).values({ tenantId: user.tenantId ?? null, terminalCode: dto.terminal_code, name: dto.name ?? null, provider: dto.provider ?? 'mock', status: 'active', createdBy: user.username });
    return { terminal_code: dto.terminal_code, provider: dto.provider ?? 'mock', status: 'active' };
  }
  async listTerminals() {
    const db = this.db as any;
    const rows = await db.select().from(paymentTerminals).orderBy(desc(paymentTerminals.id));
    return { terminals: rows.map((r: any) => ({ terminal_code: r.terminalCode, name: r.name, provider: r.provider, status: r.status, last_seen_at: r.lastSeenAt })), count: rows.length };
  }

  // ── Charge / pre-auth ──────────────────────────────────────────────────────
  async charge(dto: ChargeDto, user: JwtUser) {
    if (!(dto.amount > 0)) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'amount must be > 0', messageTh: 'จำนวนเงินไม่ถูกต้อง' });
    const db = this.db as any;
    let provider = 'mock';
    if (dto.terminal_code) {
      const [t] = await db.select().from(paymentTerminals).where(eq(paymentTerminals.terminalCode, dto.terminal_code)).limit(1);
      if (t) provider = t.provider ?? 'mock';
    }
    const type = dto.type ?? 'sale';
    const { ref, status } = this.chargeViaProvider(provider, dto.amount, type);
    const intentNo = await this.docNo.nextDaily('PTI');
    const captured = status === 'Captured';
    await db.insert(paymentIntents).values({
      tenantId: user.tenantId ?? null, intentNo, saleNo: dto.sale_no ?? null, terminalCode: dto.terminal_code ?? null,
      provider, providerRef: ref, type, amount: String(round2(dto.amount)), capturedAmount: captured ? String(round2(dto.amount)) : '0',
      currency: dto.currency ?? 'THB', status, createdBy: user.username, capturedAt: captured ? new Date() : null,
    });
    return { intent_no: intentNo, provider, provider_ref: ref, status, type, amount: round2(dto.amount) };
  }

  async capture(intentNo: string, amount: number | undefined, user: JwtUser) {
    const db = this.db as any;
    return db.transaction(async (tx: any) => {
      const [i] = await tx.select().from(paymentIntents).where(eq(paymentIntents.intentNo, intentNo)).limit(1).for('update');
      if (!i) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Intent not found', messageTh: 'ไม่พบรายการชำระ' });
      if (i.status !== 'Authorized') throw new BadRequestException({ code: 'NOT_AUTHORIZED', message: `Cannot capture a ${i.status} intent`, messageTh: 'จับยอดไม่ได้' });
      const cap = round2(amount ?? n(i.amount));
      if (cap > n(i.amount) + 0.001) throw new BadRequestException({ code: 'OVER_CAPTURE', message: 'Capture exceeds authorized amount', messageTh: 'จับยอดเกินวงเงิน' });
      await tx.update(paymentIntents).set({ status: 'Captured', capturedAmount: String(cap), capturedAt: new Date() }).where(eq(paymentIntents.id, i.id));
      void user;
      return { intent_no: intentNo, status: 'Captured', captured_amount: cap };
    });
  }

  async voidIntent(intentNo: string) {
    const db = this.db as any;
    return db.transaction(async (tx: any) => {
      const [i] = await tx.select().from(paymentIntents).where(eq(paymentIntents.intentNo, intentNo)).limit(1).for('update');
      if (!i) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Intent not found', messageTh: 'ไม่พบรายการชำระ' });
      if (i.status === 'Captured' || i.status === 'Refunded') throw new BadRequestException({ code: 'CANNOT_VOID', message: `Cannot void a ${i.status} intent — refund instead`, messageTh: 'ยกเลิกไม่ได้ ใช้คืนเงินแทน' });
      await tx.update(paymentIntents).set({ status: 'Voided' }).where(eq(paymentIntents.id, i.id));
      return { intent_no: intentNo, status: 'Voided' };
    });
  }

  async refundIntent(intentNo: string, amount: number) {
    const db = this.db as any;
    return db.transaction(async (tx: any) => {
      const [i] = await tx.select().from(paymentIntents).where(eq(paymentIntents.intentNo, intentNo)).limit(1).for('update');
      if (!i) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Intent not found', messageTh: 'ไม่พบรายการชำระ' });
      if (i.status !== 'Captured') throw new BadRequestException({ code: 'NOT_CAPTURED', message: 'Only captured intents can be refunded', messageTh: 'คืนเงินได้เฉพาะรายการที่จับยอดแล้ว' });
      if (round2(amount) > n(i.capturedAmount) + 0.001) throw new BadRequestException({ code: 'OVER_REFUND', message: 'Refund exceeds captured amount', messageTh: 'คืนเงินเกินยอดที่จับ' });
      const remaining = round2(n(i.capturedAmount) - round2(amount));
      await tx.update(paymentIntents).set({ status: remaining <= 0.001 ? 'Refunded' : 'Captured', capturedAmount: String(remaining) }).where(eq(paymentIntents.id, i.id));
      return { intent_no: intentNo, refunded: round2(amount), remaining };
    });
  }

  // PSP webhook (idempotent on provider_ref). Public — derive nothing from auth.
  async webhook(provider: string, providerRef: string, status: string) {
    const db = this.db as any;
    const [i] = await db.select().from(paymentIntents).where(and(eq(paymentIntents.provider, provider), eq(paymentIntents.providerRef, providerRef))).limit(1);
    if (!i) return { ok: true, note: 'no matching intent' }; // idempotent / unknown → ack
    if (i.status === status) return { ok: true, note: 'already' };
    const set: any = { status };
    if (status === 'Captured') { set.capturedAmount = i.amount; set.capturedAt = new Date(); }
    await db.update(paymentIntents).set(set).where(eq(paymentIntents.id, i.id));
    return { ok: true, intent_no: i.intentNo, status };
  }

  // ── Settlement ─────────────────────────────────────────────────────────────
  // Batch all unsettled Captured intents for the day, compute fees/net, mark Settled.
  async settle(dto: { fee_pct?: number; date?: string }, user: JwtUser) {
    const db = this.db as any;
    const open = await db.select().from(paymentIntents).where(and(eq(paymentIntents.status, 'Captured'), isNull(paymentIntents.settlementBatchNo)));
    if (!open.length) throw new BadRequestException({ code: 'NOTHING_TO_SETTLE', message: 'No captured intents to settle', messageTh: 'ไม่มีรายการให้สรุปยอด' });
    const gross = round2(open.reduce((a: number, r: any) => a + n(r.capturedAmount), 0));
    const fees = round2(gross * (dto.fee_pct ?? 0) / 100);
    const batchNo = await this.docNo.nextDaily('STL');
    await db.transaction(async (tx: any) => {
      await tx.insert(settlementBatches).values({ tenantId: user.tenantId ?? null, batchNo, provider: open[0].provider, batchDate: dto.date ?? ymd(), gross: String(gross), fees: String(fees), net: String(round2(gross - fees)), txnCount: open.length, status: 'Settled' });
      for (const i of open) await tx.update(paymentIntents).set({ settlementBatchNo: batchNo }).where(eq(paymentIntents.id, i.id));
    });
    return { batch_no: batchNo, gross, fees, net: round2(gross - fees), txn_count: open.length, status: 'Settled' };
  }

  async listSettlements(limit = 50) {
    const db = this.db as any;
    const rows = await db.select().from(settlementBatches).orderBy(desc(settlementBatches.id)).limit(limit);
    return { batches: rows.map((r: any) => ({ batch_no: r.batchNo, provider: r.provider, batch_date: r.batchDate, gross: n(r.gross), fees: n(r.fees), net: n(r.net), txn_count: r.txnCount, status: r.status })), count: rows.length };
  }

  async reconcile(batchNo: string, user: JwtUser) {
    const db = this.db as any;
    const [b] = await db.select().from(settlementBatches).where(eq(settlementBatches.batchNo, batchNo)).limit(1);
    if (!b) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Batch not found', messageTh: 'ไม่พบรอบสรุปยอด' });
    await db.update(settlementBatches).set({ status: 'Reconciled', reconciledBy: user.username }).where(eq(settlementBatches.id, b.id));
    return { batch_no: batchNo, status: 'Reconciled' };
  }

  async listIntents(saleNo?: string, limit = 100) {
    const db = this.db as any;
    const where = saleNo ? eq(paymentIntents.saleNo, saleNo) : undefined;
    const rows = await db.select().from(paymentIntents).where(where).orderBy(desc(paymentIntents.id)).limit(limit);
    return { intents: rows.map((r: any) => ({ intent_no: r.intentNo, sale_no: r.saleNo, provider: r.provider, type: r.type, amount: n(r.amount), captured_amount: n(r.capturedAmount), status: r.status, settlement_batch_no: r.settlementBatchNo })), count: rows.length };
  }
}

function hash(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) { h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; } return h; }
