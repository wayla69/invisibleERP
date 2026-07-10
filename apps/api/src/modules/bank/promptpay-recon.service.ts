import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, gt, isNotNull, sql, type SQL } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { bankAccounts, bankStatementLines, payments, posSettlementAccounts, promptpayTillExceptions } from '../../database/schema';
import { n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { greedyMatch, round4, type BankSide, type BookSide } from './match-engine';

// POS-8 / control POS-08 — PromptPay store-level auto-reconciliation.
//
// A PromptPay QR tender is captured at the till as Pending (the payer settles out-of-band); the funds later
// land on the store's house-bank statement as an inflow. This service confirms that settlement AUTOMATICALLY:
// it takes the day's PromptPay tenders (the "book" side) and the imported bank-statement INFLOWS on the
// store's settlement account (the "bank" side) and runs them through the SAME auto-match engine the GL bank
// reconciliation uses (match-engine.ts — amount / date-window / payer-ref). A tender with no matching inflow
// is surfaced as a till/cash EXCEPTION (mirrors the till-variance exception surface) — Open until a manager
// clears it — so an unsettled or short-settled QR taking never goes unnoticed.
@Injectable()
export class PromptPayReconService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // ── Store settlement-account map ──

  // Set (or replace) the house-bank account this store's PromptPay collections settle into.
  async setSettlementAccount(dto: { bank_account_id: number }, user: JwtUser) {
    const db = this.db;
    const tenantId = user.tenantId;
    if (tenantId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'A store (tenant) context is required', messageTh: 'ต้องระบุร้าน (tenant)' });
    const acct = await this.loadAccount(dto.bank_account_id);
    if (acct.tenantId != null && Number(acct.tenantId) !== Number(tenantId)) {
      throw new BadRequestException({ code: 'BANK_ACCOUNT_OTHER_TENANT', message: 'That bank account belongs to another store', messageTh: 'บัญชีธนาคารเป็นของร้านอื่น' });
    }
    await db.insert(posSettlementAccounts)
      .values({ tenantId, bankAccountId: dto.bank_account_id, createdBy: user.username })
      .onConflictDoUpdate({ target: posSettlementAccounts.tenantId, set: { bankAccountId: dto.bank_account_id, updatedAt: new Date() } });
    return { tenant_id: Number(tenantId), bank_account_id: dto.bank_account_id, bank: `${acct.bankName} ${acct.accountNo}` };
  }

  async getSettlementAccount(user: JwtUser) {
    const map = await this.resolveSettlement(user, undefined);
    if (!map) return { settlement_account: null };
    return { settlement_account: { bank_account_id: map.id, bank_name: map.bankName, account_no: map.accountNo, gl_account_code: map.glAccountCode } };
  }

  // ── Reconcile a business day ──

  // Match the day's PromptPay tenders to unreconciled inflow lines on the settlement account (reusing the
  // bank auto-match engine), record the matches on the statement lines, and Open/refresh a till exception
  // for every tender left unmatched. Idempotent: a tender already matched to a statement line is skipped,
  // and a re-run that finds a late inflow auto-resolves the tender's open exception.
  async reconcile(dto: { recon_date: string; bank_account_id?: number }, user: JwtUser) {
    const db = this.db;
    if (!dto.recon_date) throw new BadRequestException({ code: 'NO_RECON_DATE', message: 'recon_date (YYYY-MM-DD) is required', messageTh: 'ต้องระบุวันที่กระทบยอด (recon_date)' });
    const acct = await this.resolveSettlement(user, dto.bank_account_id);
    if (!acct) throw new BadRequestException({ code: 'NO_SETTLEMENT_ACCOUNT', message: 'No PromptPay settlement account configured for this store', messageTh: 'ยังไม่ได้ตั้งค่าบัญชีรับชำระพร้อมเพย์ของร้าน' });
    const tenantId = acct.tenantId != null ? Number(acct.tenantId) : (user.tenantId as number);
    if (tenantId == null) throw new BadRequestException({ code: 'NO_TENANT', message: 'A store (tenant) context is required', messageTh: 'ต้องระบุร้าน (tenant)' });

    // Book side: the day's PromptPay tenders (method PromptPay/QR or gateway 'promptpay') that could settle —
    // Pending (awaiting settlement) or Captured — scoped to the store, and NOT already matched to a line.
    const dayTenders = await db.select({ paymentNo: payments.paymentNo, amount: payments.amount, gatewayRef: payments.gatewayRef, tillSessionId: payments.tillSessionId, createdAt: payments.createdAt })
      .from(payments)
      .where(and(
        eq(payments.tenantId, tenantId),
        sql`(${payments.method}::text IN ('PromptPay','QR') OR ${payments.gateway}::text = 'promptpay')`,
        sql`${payments.status}::text IN ('Pending','Captured','Settled')`,
        sql`${payments.createdAt} >= ${dto.recon_date}::date`,
        sql`${payments.createdAt} < (${dto.recon_date}::date + 1)`,
      ));
    // Exclude tenders already matched to a statement line on this settlement account (idempotent re-run).
    const matchedRows = await db.select({ pn: bankStatementLines.matchedPaymentNo }).from(bankStatementLines)
      .where(and(eq(bankStatementLines.bankAccountId, Number(acct.id)), isNotNull(bankStatementLines.matchedPaymentNo)));
    const alreadyMatched = new Set(matchedRows.map((r: any) => String(r.pn)));
    const tenders = dayTenders.filter((t: any) => !alreadyMatched.has(String(t.paymentNo)));

    // Bank side: unreconciled INFLOW lines (amount > 0 — credits) on the settlement account.
    const inflows = await db.select().from(bankStatementLines)
      .where(and(eq(bankStatementLines.bankAccountId, Number(acct.id)), eq(bankStatementLines.reconciled, 'false'), gt(bankStatementLines.amount, '0')));

    const bankSide: BankSide<any>[] = inflows.map((l: any) => ({ line: l, amount: n(l.amount), date: l.lineDate, ref: l.description }));
    const bookSide: BookSide<any>[] = tenders.map((t: any) => ({ entry: t, amount: n(t.amount), date: t.createdAt, ref: t.gatewayRef }));

    const { matches } = greedyMatch(bankSide, bookSide);

    // Record each match on the statement line (reconciled + matched_payment_no) and auto-resolve any open
    // exception the tender may have carried from a prior run (the funds have now arrived).
    const matchedPaymentNos = new Set<string>();
    for (const m of matches) {
      const pn = String(m.book.entry.paymentNo);
      matchedPaymentNos.add(pn);
      await db.update(bankStatementLines).set({ reconciled: 'true', matchedPaymentNo: pn }).where(eq(bankStatementLines.id, Number(m.bank.line.id)));
      await db.update(promptpayTillExceptions).set({ status: 'Resolved', resolvedBy: 'auto-match', resolvedAt: new Date(), note: 'Auto-matched to bank inflow on re-run' })
        .where(and(eq(promptpayTillExceptions.tenantId, tenantId), eq(promptpayTillExceptions.paymentNo, pn), eq(promptpayTillExceptions.status, 'Open')));
    }

    // Every tender left unmatched becomes (or refreshes) an OPEN till exception.
    const unmatchedTenders = tenders.filter((t: any) => !matchedPaymentNos.has(String(t.paymentNo)));
    for (const t of unmatchedTenders) {
      await db.insert(promptpayTillExceptions)
        .values({ tenantId, reconDate: dto.recon_date, paymentNo: String(t.paymentNo), tillSessionId: t.tillSessionId != null ? Number(t.tillSessionId) : null, bankAccountId: Number(acct.id), amount: fx(n(t.amount), 4), gatewayRef: t.gatewayRef ?? null, status: 'Open' })
        .onConflictDoUpdate({ target: [promptpayTillExceptions.tenantId, promptpayTillExceptions.paymentNo], set: { reconDate: dto.recon_date, amount: fx(n(t.amount), 4), status: 'Open', bankAccountId: Number(acct.id) } });
    }

    const unmatchedInflows = bankSide.filter((b) => !matches.some((m) => m.bank === b));
    return {
      recon_date: dto.recon_date,
      bank_account_id: Number(acct.id),
      promptpay_tenders: tenders.length,
      matched: matches.length,
      matched_amount: round4(matches.reduce((a, m) => a + m.book.amount, 0)),
      unmatched_tenders: unmatchedTenders.length,
      exceptions: unmatchedTenders.map((t: any) => ({ payment_no: t.paymentNo, amount: n(t.amount), gateway_ref: t.gatewayRef ?? null })),
      unmatched_inflows: unmatchedInflows.map((b) => ({ statement_line_id: Number(b.line.id), amount: b.amount, date: b.line.lineDate, description: b.line.description })),
    };
  }

  // ── Exception surface ──

  async listExceptions(status: string | undefined, user: JwtUser) {
    const db = this.db;
    const tenantId = user.tenantId;
    const conds: SQL[] = [];
    if (tenantId != null) conds.push(eq(promptpayTillExceptions.tenantId, tenantId));
    if (status) conds.push(eq(promptpayTillExceptions.status, status));
    const rows = await db.select().from(promptpayTillExceptions).where(conds.length ? and(...conds) : undefined).orderBy(promptpayTillExceptions.reconDate);
    return {
      exceptions: rows.map((r: any) => ({ id: Number(r.id), recon_date: r.reconDate, payment_no: r.paymentNo, till_session_id: r.tillSessionId != null ? Number(r.tillSessionId) : null, amount: n(r.amount), gateway_ref: r.gatewayRef, status: r.status, note: r.note, resolved_by: r.resolvedBy, resolved_at: r.resolvedAt })),
      count: rows.length,
      open: rows.filter((r: any) => r.status === 'Open').length,
    };
  }

  // A manager clears (Resolved) a PromptPay till exception after investigating (mirrors clearing a till
  // variance). The tender is confirmed handled off-system; the exception drops off the open worklist.
  async clearException(id: number, user: JwtUser, note?: string) {
    const db = this.db;
    const [exc] = await db.select().from(promptpayTillExceptions).where(eq(promptpayTillExceptions.id, id)).limit(1);
    if (!exc) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Exception not found', messageTh: 'ไม่พบรายการผิดปกติ' });
    if (String(exc.status) !== 'Open') throw new BadRequestException({ code: 'NOT_OPEN', message: 'Exception is not open', messageTh: 'รายการนี้ไม่ได้เปิดค้างอยู่' });
    await db.update(promptpayTillExceptions).set({ status: 'Resolved', resolvedBy: user.username, resolvedAt: new Date(), note: note ?? exc.note }).where(eq(promptpayTillExceptions.id, id));
    return { id, status: 'Resolved', resolved_by: user.username, payment_no: exc.paymentNo };
  }

  // ── Helpers ──

  private async resolveSettlement(user: JwtUser, bankAccountId?: number) {
    const db = this.db;
    if (bankAccountId != null) return this.loadAccount(bankAccountId);
    if (user.tenantId == null) return null;
    const [map] = await db.select({ bankAccountId: posSettlementAccounts.bankAccountId }).from(posSettlementAccounts).where(eq(posSettlementAccounts.tenantId, user.tenantId)).limit(1);
    if (!map) return null;
    return this.loadAccount(Number(map.bankAccountId));
  }

  private async loadAccount(id: number) {
    const [a] = await this.db.select().from(bankAccounts).where(eq(bankAccounts.id, id)).limit(1);
    if (!a) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Bank account not found', messageTh: 'ไม่พบบัญชีธนาคาร' });
    return a;
  }
}
