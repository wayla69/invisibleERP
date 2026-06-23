import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { revRecSchedules, revRecLines, journalEntries } from '../../database/schema';
import { LedgerService } from '../ledger/ledger.service';
import { DocNumberService } from '../../common/doc-number.service';
import { n, fx, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;
function splitStraightLine(total: number, months: number): number[] {
  const per = Math.floor((total / months) * 10000) / 10000;
  const arr = Array(months).fill(per);
  arr[months - 1] = round4(total - per * (months - 1));
  return arr;
}
function addMonths(period: string, k: number): string {
  const [y, m] = period.split('-').map(Number);
  const idx = y * 12 + (m - 1) + k;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

export interface CreateScheduleDto { source_ref?: string; total_amount: number; start_period: string; months: number; currency?: string; receipt_date?: string; notes?: string; tenantId?: number | null; createdBy: string }

@Injectable()
export class RevenueService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly ledger: LedgerService,
    private readonly docNo: DocNumberService,
  ) {}

  // create a deferral schedule + book the cash-in-advance to 2400 Unearned Revenue
  async createSchedule(dto: CreateScheduleDto) {
    const db = this.db as any;
    if (dto.months < 1 || dto.total_amount <= 0 || !/^\d{4}-\d{2}$/.test(dto.start_period)) throw new BadRequestException({ code: 'INVALID', message: 'months>=1, total>0, start_period YYYY-MM', messageTh: 'ข้อมูลไม่ถูกต้อง' });
    const total = n(dto.total_amount);
    const amounts = splitStraightLine(total, dto.months);
    const endPeriod = addMonths(dto.start_period, dto.months - 1);
    const currency = dto.currency ?? 'THB';
    const scheduleNo = await this.docNo.nextDaily('DEFREV');
    let deferralJournalNo: string | null = null;
    if (!(await this.ledger.alreadyPosted('DEFREV', scheduleNo))) {
      const je: any = await this.ledger.postEntry({ date: dto.receipt_date ?? ymd(), source: 'DEFREV', sourceRef: scheduleNo, tenantId: dto.tenantId ?? null, currency, memo: `Deferred revenue ${scheduleNo}`, createdBy: dto.createdBy, lines: [{ account_code: '1000', debit: total }, { account_code: '2400', credit: total }] });
      deferralJournalNo = je?.entry_no ?? null;
    }
    const [h] = await db.insert(revRecSchedules).values({ scheduleNo, tenantId: dto.tenantId ?? null, sourceRef: dto.source_ref ?? null, totalAmount: fx(total, 4), startPeriod: dto.start_period, endPeriod, months: dto.months, deferredAccount: '2400', revenueAccount: '4000', currency, status: 'active', deferralJournalNo, notes: dto.notes ?? null, createdBy: dto.createdBy }).returning({ id: revRecSchedules.id });
    await db.insert(revRecLines).values(amounts.map((amt, i) => ({ scheduleId: Number(h.id), tenantId: dto.tenantId ?? null, period: addMonths(dto.start_period, i), amount: fx(amt, 4), recognized: false })));
    return { schedule_no: scheduleNo, total_amount: total, months: dto.months, start_period: dto.start_period, end_period: endPeriod, deferral_journal_no: deferralJournalNo, lines: amounts.map((amt, i) => ({ period: addMonths(dto.start_period, i), amount: round4(amt) })) };
  }

  // recognize all due (unrecognized) lines for one period: Dr 2400 / Cr 4000
  async runRecognition(period: string, user: JwtUser, explicitTenantId?: number | null) {
    const db = this.db as any;
    // Scope to one tenant: a tenant-bound user recognizes their own; an HQ/Admin caller (whose request
    // bypasses RLS) MUST name a tenant — otherwise this would recognize EVERY tenant's due lines in one call.
    const tenantId = user.tenantId ?? (explicitTenantId != null ? Number(explicitTenantId) : null);
    if (tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'HQ/Admin must specify tenant_id to run revenue recognition', messageTh: 'สำนักงานใหญ่ต้องระบุ tenant_id' });
    const rows = await db.select({ line: revRecLines, sched: revRecSchedules }).from(revRecLines).innerJoin(revRecSchedules, eq(revRecLines.scheduleId, revRecSchedules.id)).where(and(eq(revRecLines.period, period), eq(revRecLines.recognized, false), eq(revRecSchedules.tenantId, tenantId)));
    const journals: any[] = []; const skipped: any[] = []; let total = 0;
    for (const r of rows) {
      const sched = r.sched, line = r.line;
      const ref = `${sched.scheduleNo}:${line.period}`;
      try {
        let journalNo: string | null = null;
        if (!(await this.ledger.alreadyPosted('REVREC', ref))) {
          const je: any = await this.ledger.postEntry({ date: `${line.period}-01`, source: 'REVREC', sourceRef: ref, tenantId: sched.tenantId, currency: sched.currency, memo: `Revenue recognition ${sched.scheduleNo} ${line.period}`, createdBy: user.username, lines: [{ account_code: sched.deferredAccount, debit: n(line.amount) }, { account_code: sched.revenueAccount, credit: n(line.amount) }] });
          journalNo = je?.entry_no ?? null;
        } else {
          // crash-recovery: the JE posted but the line wasn't marked — recover the existing entry_no so the
          // audit link is preserved instead of persisting journalNo = null.
          const [existing] = await db.select({ entryNo: journalEntries.entryNo }).from(journalEntries).where(and(eq(journalEntries.source, 'REVREC'), eq(journalEntries.sourceRef, ref))).limit(1);
          journalNo = existing?.entryNo ?? null;
        }
        await db.update(revRecLines).set({ recognized: true, journalNo }).where(eq(revRecLines.id, line.id));
        journals.push({ schedule_no: sched.scheduleNo, journal_no: journalNo, amount: n(line.amount) });
        total = round4(total + n(line.amount));
        // mark schedule completed if all lines recognized
        const remaining = await db.select({ id: revRecLines.id }).from(revRecLines).where(and(eq(revRecLines.scheduleId, Number(sched.id)), eq(revRecLines.recognized, false)));
        if (remaining.length === 0) await db.update(revRecSchedules).set({ status: 'completed' }).where(eq(revRecSchedules.id, sched.id));
      } catch (e: any) {
        skipped.push({ schedule_no: sched.scheduleNo, reason: e?.response?.code ?? e?.code ?? 'ERROR' });
      }
    }
    return { period, recognized_count: journals.length, total_recognized: total, journals, skipped };
  }

  async listSchedules(q: { status?: string; source_ref?: string }) {
    const db = this.db as any;
    const conds: any[] = [];
    if (q.status) conds.push(eq(revRecSchedules.status, q.status));
    if (q.source_ref) conds.push(eq(revRecSchedules.sourceRef, q.source_ref));
    const scheds = await db.select().from(revRecSchedules).where(conds.length ? and(...conds) : undefined).orderBy(revRecSchedules.id);
    const out = [];
    for (const sc of scheds) {
      const lines = await db.select().from(revRecLines).where(eq(revRecLines.scheduleId, Number(sc.id)));
      const recognized = round4(lines.filter((l: any) => l.recognized).reduce((a: number, l: any) => a + n(l.amount), 0));
      out.push({ schedule_no: sc.scheduleNo, source_ref: sc.sourceRef, total_amount: n(sc.totalAmount), start_period: sc.startPeriod, end_period: sc.endPeriod, months: sc.months, status: sc.status, recognized_amount: recognized, remaining_amount: round4(n(sc.totalAmount) - recognized), deferral_journal_no: sc.deferralJournalNo });
    }
    return { schedules: out, count: out.length };
  }

  // deferred-revenue report: unrecognized lines vs the GL 2400 balance
  async remainingDeferred(asOf?: string) {
    const db = this.db as any;
    const scheds = await db.select().from(revRecSchedules);
    let deferredBalance = 0; const bySchedule: any[] = [];
    for (const sc of scheds) {
      const lines = await db.select().from(revRecLines).where(eq(revRecLines.scheduleId, Number(sc.id)));
      const recognized = round4(lines.filter((l: any) => l.recognized).reduce((a: number, l: any) => a + n(l.amount), 0));
      const remaining = round4(n(sc.totalAmount) - recognized);
      deferredBalance = round4(deferredBalance + remaining);
      bySchedule.push({ schedule_no: sc.scheduleNo, total: n(sc.totalAmount), recognized, remaining });
    }
    const tb: any = await this.ledger.trialBalance();
    const row2400 = (tb.rows ?? []).find((r: any) => r.account_code === '2400');
    const glUnearned = row2400 ? round4(-n(row2400.balance)) : 0; // liability: TB balance negative → flip
    return { as_of: asOf ?? null, deferred_balance: deferredBalance, gl_unearned: glUnearned, reconciled: Math.abs(deferredBalance - glUnearned) < 0.01, by_schedule: bySchedule };
  }
}
