import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { eq, and, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { reconPeriods, reconItems } from '../../database/schema/reconciliation';
import { journalEntries, journalLines } from '../../database/schema/ledger';
import { n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;

@Injectable()
export class ReconciliationService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // ── Open / find recon period ──

  async openPeriod(dto: { account_code: string; period: string }, user: JwtUser) {
    const db = this.db;
    const tenantId = user.tenantId!;

    // Compute GL balance for the account + period
    const [glRow] = await db.select({
      net: sql<string>`coalesce(sum(${journalLines.debit}) - sum(${journalLines.credit}), 0)`,
    }).from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(
        eq(journalEntries.tenantId, tenantId),
        eq(journalEntries.period, dto.period),
        eq(journalEntries.status, 'Posted'),
        eq(journalLines.accountCode, dto.account_code),
      ));

    const glBalance = n(glRow?.net ?? 0);

    const [existing] = await db.select().from(reconPeriods)
      .where(and(eq(reconPeriods.tenantId, tenantId), eq(reconPeriods.accountCode, dto.account_code), eq(reconPeriods.period, dto.period)))
      .limit(1);

    if (existing) return this.fmtPeriod(existing);

    const [rp] = await db.insert(reconPeriods).values({
      tenantId, accountCode: dto.account_code, period: dto.period,
      status: 'Open', glBalance: fx(glBalance, 4), subledgerBalance: '0',
      preparedBy: user.username, preparedAt: new Date(),
    }).returning();
    return this.fmtPeriod(rp);
  }

  // ── Import GL items into recon workspace ──

  async importGlItems(reconPeriodId: number, user: JwtUser) {
    const db = this.db;
    const rp = await this.assertPeriod(reconPeriodId, user);

    const glLines = await db.select({
      id: journalLines.id,
      refDoc: journalEntries.entryNo,
      amount: sql<string>`${journalLines.debit} - ${journalLines.credit}`,
    }).from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(
        eq(journalEntries.tenantId, rp.tenantId!),
        eq(journalEntries.period, rp.period),
        eq(journalEntries.status, 'Posted'),
        eq(journalLines.accountCode, rp.accountCode),
      ));

    if (!glLines.length) return { imported: 0 };

    await db.insert(reconItems).values(
      glLines.map((l: any) => ({
        reconPeriodId, source: 'GL', refDoc: l.refDoc, refLineId: Number(l.id),
        amount: fx(n(l.amount), 4), isMatched: false,
      }))
    ).onConflictDoNothing();

    // Update GL balance
    const glBalance = round4(glLines.reduce((s: number, l: any) => s + n(l.amount), 0));
    await db.update(reconPeriods).set({ glBalance: fx(glBalance, 4), preparedBy: user.username, preparedAt: new Date() }).where(eq(reconPeriods.id, reconPeriodId));

    return { imported: glLines.length, gl_balance: glBalance };
  }

  // ── Add a manual subledger / adjustment item ──

  async addItem(reconPeriodId: number, dto: { source: 'Subledger' | 'Adjustment'; amount: number; ref_doc?: string; notes?: string }, user: JwtUser) {
    const db = this.db;
    await this.assertPeriod(reconPeriodId, user);

    const [item] = await db.insert(reconItems).values({
      reconPeriodId, source: dto.source, refDoc: dto.ref_doc ?? null,
      amount: fx(dto.amount, 4), isMatched: false, notes: dto.notes ?? null,
    }).returning();

    // Recompute subledger balance
    const [sbRow] = await db.select({
      net: sql<string>`coalesce(sum(${reconItems.amount}),0)`,
    }).from(reconItems).where(and(eq(reconItems.reconPeriodId, reconPeriodId), eq(reconItems.source, 'Subledger')));
    await db.update(reconPeriods).set({ subledgerBalance: fx(n(sbRow?.net ?? 0), 4) }).where(eq(reconPeriods.id, reconPeriodId));

    return { id: Number(item!.id), source: item!.source, amount: n(item!.amount), ref_doc: item!.refDoc };
  }

  // ── Auto-match GL items to Subledger items by amount ──

  async autoMatch(reconPeriodId: number, user: JwtUser) {
    const db = this.db;
    await this.assertPeriod(reconPeriodId, user);

    const glItems = await db.select().from(reconItems).where(and(eq(reconItems.reconPeriodId, reconPeriodId), eq(reconItems.source, 'GL'), eq(reconItems.isMatched, false)));
    const sbItems = await db.select().from(reconItems).where(and(eq(reconItems.reconPeriodId, reconPeriodId), eq(reconItems.source, 'Subledger'), eq(reconItems.isMatched, false)));

    // Build amount → subledger item index for greedy match
    const sbByAmount = new Map<string, any[]>();
    for (const s of sbItems) {
      const k = fx(n(s.amount), 4);
      if (!sbByAmount.has(k)) sbByAmount.set(k, []);
      sbByAmount.get(k)!.push(s);
    }

    let matched = 0;
    for (const gl of glItems) {
      const k = fx(n(gl.amount), 4);
      const pool = sbByAmount.get(k);
      if (pool?.length) {
        const sb = pool.shift()!;
        await db.update(reconItems).set({ isMatched: true, matchedItemId: Number(sb.id) }).where(eq(reconItems.id, gl.id));
        await db.update(reconItems).set({ isMatched: true, matchedItemId: Number(gl.id) }).where(eq(reconItems.id, sb.id));
        matched++;
      }
    }

    const unmatched = glItems.length - matched;
    if (unmatched === 0) {
      await db.update(reconPeriods).set({ status: 'Reconciled' }).where(eq(reconPeriods.id, reconPeriodId));
    }

    return { matched_pairs: matched, unmatched_gl: unmatched };
  }

  // ── Certify (SoD: certifier ≠ preparer) ──

  async certify(reconPeriodId: number, user: JwtUser) {
    const db = this.db;
    const rp = await this.assertPeriod(reconPeriodId, user);

    if (rp.status === 'Open') throw new BadRequestException({ code: 'NOT_RECONCILED', message: 'Period must be reconciled before certification', messageTh: 'ต้องกระทบยอดก่อนรับรอง' });
    if (rp.status === 'Certified') throw new BadRequestException({ code: 'ALREADY_CERTIFIED', message: 'Period already certified', messageTh: 'รับรองแล้ว' });
    if (rp.preparedBy && rp.preparedBy === user.username) {
      throw new ForbiddenException({ code: 'SOD_VIOLATION', message: 'Certifier must be different from preparer (SoD)', messageTh: 'ผู้รับรองต้องไม่ใช่คนเดียวกับผู้จัดทำ (SoD)' });
    }

    const [updated] = await db.update(reconPeriods)
      .set({ status: 'Certified', certifiedBy: user.username, certifiedAt: new Date() })
      .where(eq(reconPeriods.id, reconPeriodId))
      .returning();
    return this.fmtPeriod(updated);
  }

  // ── Summary ──

  async getPeriodSummary(reconPeriodId: number, user: JwtUser) {
    const db = this.db;
    const rp = await this.assertPeriod(reconPeriodId, user);

    const items = await db.select().from(reconItems).where(eq(reconItems.reconPeriodId, reconPeriodId));
    const total = items.length;
    const matchedCount = items.filter((i: any) => i.isMatched).length;
    const unmatchedGl = items.filter((i: any) => i.source === 'GL' && !i.isMatched).length;
    const unmatchedSub = items.filter((i: any) => i.source === 'Subledger' && !i.isMatched).length;

    return {
      ...this.fmtPeriod(rp),
      items: { total, matched: matchedCount, unmatched_gl: unmatchedGl, unmatched_subledger: unmatchedSub },
    };
  }

  async listPeriods(user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(reconPeriods).where(eq(reconPeriods.tenantId, user.tenantId!)).orderBy(reconPeriods.period);
    return { periods: rows.map((r: any) => this.fmtPeriod(r)), count: rows.length };
  }

  // ── Helpers ──

  private async assertPeriod(id: number, user: JwtUser) {
    const db = this.db;
    const [rp] = await db.select().from(reconPeriods).where(eq(reconPeriods.id, id)).limit(1);
    if (!rp) throw new NotFoundException({ code: 'RECON_NOT_FOUND', message: `Recon period ${id} not found` });
    return rp;
  }

  private fmtPeriod(rp: any) {
    return {
      id: Number(rp.id), account_code: rp.accountCode, period: rp.period, status: rp.status,
      gl_balance: n(rp.glBalance), subledger_balance: n(rp.subledgerBalance),
      prepared_by: rp.preparedBy, prepared_at: rp.preparedAt,
      certified_by: rp.certifiedBy, certified_at: rp.certifiedAt,
    };
  }
}
