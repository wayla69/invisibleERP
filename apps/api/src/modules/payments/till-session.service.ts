import { NotFoundException, BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { eq, and, desc, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { payments, paymentRefunds, tillSessions, cashMovements, xzReports, xzReportDenominations } from '../../database/schema';
import type { DocNumberService } from '../../common/doc-number.service';
import type { LedgerService } from '../ledger/ledger.service';
import { postingDefault } from '../ledger/posting-events';
import type { TillPolicy } from './till-policy';
import { roundCurrency } from '../tax/money';
import { n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { CASH_VARIANCE_THRESHOLD, type OpenTillDto, type CloseTillDto, type TillSettingsDto, type CashMovementDto } from './payments.service';

// Till-session domain sub-service (POS-01/POS-07 + the P1c blind close): open/close/variance
// maker-checker, drawer cash movements, and the X/Z shift reports with the tamper-evident signed Z-tape —
// a PLAIN class built in the PaymentService ctor body (not a DI provider; the god-service ratchet
// pattern). Method bodies moved VERBATIM from the facade; the tender/refund lifecycle stays there.
export class TillSessionService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly ledger: LedgerService,
    private readonly tillPolicy: TillPolicy,
  ) {}

  // ── Blind drawer close (0426, docs/50 Wave 1 — P1c): policy logic lives in till-policy.ts. ──
  getTillSettings(user: JwtUser) { return this.tillPolicy.getSettings(user); }
  putTillSettings(dto: TillSettingsDto, user: JwtUser) { return this.tillPolicy.putSettings(dto, user); }

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
  // Pending list — recent till sessions; feeds the /pos/close-of-day session dropdown so the Z-report
  // signer picks the TILL-… session instead of typing it. Read-only; RLS scopes to the caller's tenant.
  async listTillSessions(_user: JwtUser, status?: string) {
    const rows = await this.db
      .select({ sessionNo: tillSessions.sessionNo, status: tillSessions.status, openedBy: tillSessions.openedBy, openedAt: tillSessions.openedAt, closedAt: tillSessions.closedAt, varianceStatus: tillSessions.varianceStatus })
      .from(tillSessions).where(status === 'Open' || status === 'Closed' ? eq(tillSessions.status, status) : undefined)
      .orderBy(desc(tillSessions.id)).limit(100);
    return { sessions: rows.map((r: any) => ({ session_no: r.sessionNo, status: r.status, opened_by: r.openedBy, opened_at: r.openedAt, closed_at: r.closedAt, variance_status: r.varianceStatus })) };
  }

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
      // docs/43 PR-2: over/short leg follows the tenant posting-rule (TILL.VARIANCE) ?? registry default;
      // cash (1000) is CASH-set pinned and stays literal. hub-sync's till replay shares this event key.
      const varAcct = (await this.ledger.postingOverrides('TILL.VARIANCE', sess.tenantId ?? null)).cash_over_short
        ?? postingDefault('TILL.VARIANCE', 'cash_over_short');
      const lines = variance < 0
        ? [{ account_code: varAcct, debit: v }, { account_code: '1000', credit: v }]
        : [{ account_code: '1000', debit: v }, { account_code: varAcct, credit: v }];
      const je: any = await this.ledger.postEntry({
        source: 'TILL_CLOSE', sourceRef: dto.session_no, tenantId: sess.tenantId ?? null,
        memo: `Till close variance ${dto.session_no} (${variance < 0 ? 'short' : 'over'} ${v})`,
        createdBy: user.username, pendingApproval: material, lines,
      });
      varianceJournalNo = je?.entry_no ?? null;
      varianceStatus = material ? 'PendingApproval' : 'NotRequired';
    }

    // Blind-close evidence: record whether the tenant policy was ON when this drawer was counted.
    // The count is already submitted at this point, so the response may reveal expected/variance.
    const blind = await this.tillPolicy.blindOn(sess.tenantId ?? null);
    await db.update(tillSessions).set({
      closedBy: user.username, closedAt: new Date(), closingCount: fx(dto.closing_count, 4),
      expectedCash: fx(expectedCash, 4), variance: fx(variance, 4), denominations: dto.denominations ?? null, status: 'Closed',
      varianceJournalNo, varianceStatus, blindClose: blind,
    }).where(eq(tillSessions.id, sess.id));
    return { session_no: dto.session_no, status: 'Closed', blind_close: blind, expected_cash: expectedCash, closing_count: n(dto.closing_count), variance, variance_status: varianceStatus, variance_journal_no: varianceJournalNo, z_report: { ...a, counted_cash: n(dto.closing_count), variance, denominations: dto.denominations ?? null } };
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
      // docs/43 PR-2: paid-in/out expense leg follows the tenant posting-rule (TILL.CASHMOV) ?? default.
      const movAcct = (await this.ledger.postingOverrides('TILL.CASHMOV', sess.tenantId ?? null)).expense
        ?? postingDefault('TILL.CASHMOV', 'expense');
      const lines = dto.type === 'paid_out'
        ? [{ account_code: movAcct, debit: amt }, { account_code: '1000', credit: amt }]
        : [{ account_code: '1000', debit: amt }, { account_code: movAcct, credit: amt }];
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
    // Drawer cash from Cash tenders = amount + tip. `payments.amount` deliberately excludes the tip (it
    // is sale money; the tip is a 2300 liability), but a CASH tip physically lands in the drawer — the
    // sale's GL debits 1000 for `cashDue = total + tip`. Omitting it made every close with a cash tip
    // read "over" by exactly the tip (a false variance that could trip the REV-13 maker-checker).
    // Tips on non-cash tenders never enter the drawer, so the Cash filter also scopes the tip.
    const [cashSales] = await db.select({ v: sql<string>`coalesce(sum(${payments.amount}),0) + coalesce(sum(${payments.tip}),0)` }).from(payments).where(and(eq(payments.tillSessionId, sessId), sql`${payments.method}::text = 'Cash'`, sql`${payments.status}::text IN ('Captured','Refunded')`));
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
  // Blind close (P1c): while the session is OPEN and the tenant policy is ON, till-duty callers get the
  // drawer-expectation figures redacted (see redactBlind) — they must count first, then close reveals.
  async xReport(tillId: number, user: JwtUser) {
    const db = this.db;
    const [sess] = await db.select().from(tillSessions).where(eq(tillSessions.id, tillId)).limit(1);
    if (!sess) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Till session not found', messageTh: 'ไม่พบรอบเงินสด' });
    let a: Record<string, any> = await this.aggregateTill(tillId);
    if (String(sess.status) === 'Open' && (await this.tillPolicy.mustRedact(user, sess.tenantId ?? null))) a = this.tillPolicy.redactBlind(a);
    return { report: 'X', session_no: sess.sessionNo, status: sess.status, ...a, counted_cash: null, variance: null };
  }

  // Z-report — shift summary at/after close. Same blind redaction as X while the session is still open;
  // once closed the count is on record, so the full reconciliation is always visible.
  async zReport(tillId: number, user: JwtUser) {
    const db = this.db;
    const [sess] = await db.select().from(tillSessions).where(eq(tillSessions.id, tillId)).limit(1);
    if (!sess) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Till session not found', messageTh: 'ไม่พบรอบเงินสด' });
    let a: Record<string, any> = await this.aggregateTill(tillId);
    const closed = String(sess.status) === 'Closed';
    if (!closed && (await this.tillPolicy.mustRedact(user, sess.tenantId ?? null))) a = this.tillPolicy.redactBlind(a);
    return { report: 'Z', session_no: sess.sessionNo, status: sess.status, blind_close: !!sess.blindClose, ...a, counted_cash: closed ? n(sess.closingCount) : null, variance: closed ? n(sess.variance) : null, denominations: sess.denominations ?? null };
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

}
