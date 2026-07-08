import { BadRequestException, NotFoundException } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { JwtUser } from '../../common/decorators';
import type { DrizzleDb } from '../../database/database.module';
import { recurringJournals, prepaidSchedules } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { currentTenantStore } from '../../common/tenant-context';
import { ymd, n } from '../../database/queries';
import { toMinor4, minorToNumber4 } from '../../common/money';
import type { RecurringJournalDto, PrepaidDto, PostEntryDto, JournalLineDto } from './ledger.service';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

// Recurring + prepaid sub-service (docs/38 §3 ledger decomposition, PR-2 — GL-08/GL-09): balanced-template
// recurring journals (create validates balance UP FRONT; the due sweep posts each template as a DRAFT JE,
// maker-checker GL-05, idempotent via the REC-<id>-<date> source_ref) and straight-line prepaid
// amortization schedules (last period takes the remainder; idempotent per (schedule, period)) — moved
// VERBATIM together with the module-level cadence helpers. A PLAIN class constructed in the LedgerService
// ctor BODY (harnesses construct the facade positionally with (db, docNo)). postEntry — the GL-05/idempotency
// core, staying on the facade until the final posting cut — arrives as a callback port.
export class LedgerRecurringService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly postEntry: (dto: PostEntryDto) => Promise<{ entry_no: string | null }>,
  ) {}

  // ───────────────────── Recurring / template journal entries (GL-08) ─────────────────────
  // A balanced template + a cadence; the scheduled job posts each due template as a DRAFT JE (maker-checker,
  // GL-05) and rolls the schedule forward. Validate the template balances UP FRONT so a malformed template
  // can never be saved and then fail silently every night.
  async createRecurring(dto: RecurringJournalDto, user: JwtUser) {
    const db = this.db;
    const lines = dto.lines ?? [];
    if (!(FREQUENCIES as readonly string[]).includes(dto.frequency)) throw new BadRequestException({ code: 'BAD_FREQUENCY', message: `frequency must be one of ${FREQUENCIES.join('/')}`, messageTh: 'รอบเวลาไม่ถูกต้อง' });
    const nz = lines.filter((l) => !(n(l.debit) === 0 && n(l.credit) === 0));
    if (!nz.length) throw new BadRequestException({ code: 'UNBALANCED', message: 'No non-zero template lines', messageTh: 'ไม่มีรายการบัญชีที่มีมูลค่า' });
    const tdM = nz.reduce((a, l) => a + toMinor4(n(l.debit)), 0n);
    const tcM = nz.reduce((a, l) => a + toMinor4(n(l.credit)), 0n);
    if (tdM !== tcM) throw new BadRequestException({ code: 'UNBALANCED', message: `Template not balanced: debit ${minorToNumber4(tdM)} != credit ${minorToNumber4(tcM)}`, messageTh: 'แม่แบบไม่สมดุล (เดบิตไม่เท่าเครดิต)' });
    const tenantId = dto.tenantId ?? currentTenantStore()?.tenantId ?? user.tenantId ?? null;
    const nextRun = dto.startDate ?? ymd();
    const [r] = await db.insert(recurringJournals).values({
      tenantId, name: dto.name, frequency: dto.frequency, memo: dto.memo ?? null,
      ledgerCode: dto.ledgerCode ?? null, currency: dto.currency ?? 'THB', lines: nz, active: 'true',
      nextRunDate: nextRun, createdBy: user.username,
    }).returning({ id: recurringJournals.id });
    return { id: Number(r!.id), name: dto.name, frequency: dto.frequency, next_run_date: nextRun, lines: nz };
  }

  async listRecurring(tenantId?: number) {
    const db = this.db;
    const where = tenantId != null ? eq(recurringJournals.tenantId, tenantId) : undefined;
    const rows = await db.select().from(recurringJournals).where(where).orderBy(desc(recurringJournals.id));
    return { recurring: rows.map((r: any) => ({
      id: Number(r.id), name: r.name, frequency: r.frequency, memo: r.memo, ledger_code: r.ledgerCode,
      currency: r.currency, lines: r.lines, active: r.active === 'true', next_run_date: r.nextRunDate,
      last_run_date: r.lastRunDate, last_entry_no: r.lastEntryNo, created_by: r.createdBy,
    })), count: rows.length };
  }

  async setRecurringActive(id: number, active: boolean) {
    const db = this.db;
    const [r] = await db.select({ id: recurringJournals.id }).from(recurringJournals).where(eq(recurringJournals.id, id)).limit(1);
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: `Recurring journal ${id} not found`, messageTh: 'ไม่พบรายการตั้งเวลา' });
    await db.update(recurringJournals).set({ active: active ? 'true' : 'false' }).where(eq(recurringJournals.id, id));
    return { id, active };
  }

  // Idempotent scheduled run: post every active template whose next_run_date has arrived as a DRAFT JE and
  // roll the schedule forward. source_ref = `REC-<id>-<date>` so the ux_je_idem index dedupes a same-day
  // re-run at the DB layer; next_run_date is also advanced on posting, so a re-run selects nothing new.
  async runDueRecurring(user: JwtUser) {
    const db = this.db;
    const today = ymd();
    const due = await db.select().from(recurringJournals)
      .where(and(eq(recurringJournals.active, 'true'), sql`${recurringJournals.nextRunDate} <= ${today}`));
    const posted: { entry_no: string | null; recurring_id: number; name: string }[] = [];
    for (const r of due) {
      const res = await this.postEntry({
        date: today, source: 'Recurring', sourceRef: `REC-${Number(r.id)}-${today}`,
        tenantId: r.tenantId ?? null, currency: r.currency ?? 'THB', memo: r.memo ?? r.name,
        lines: r.lines as JournalLineDto[], createdBy: `${user?.username ?? 'system'} (recurring)`,
        ledgerCode: r.ledgerCode ?? null, pendingApproval: true,
      });
      await db.update(recurringJournals).set({
        lastRunDate: today, lastEntryNo: res.entry_no ?? r.lastEntryNo,
        nextRunDate: addByFrequency(today, r.frequency),
      }).where(eq(recurringJournals.id, r.id));
      if (res.entry_no) posted.push({ entry_no: res.entry_no, recurring_id: Number(r.id), name: r.name });
    }
    return { as_of: today, scanned: due.length, posted: posted.length, entries: posted };
  }

  // ───────────────────── Prepaid amortization schedules (GL-09) ─────────────────────
  // Register a prepaid asset (annual insurance, rent up front) once; the scheduled run amortizes a
  // straight-line slice each period (Dr expense / Cr 1280), the last period taking the remainder so it
  // fully clears. Posts directly (systematic, like depreciation) — idempotent per (schedule, period).
  async createPrepaid(dto: PrepaidDto, user: JwtUser) {
    const db = this.db;
    const total = round2(dto.totalAmount);
    if (!(total > 0)) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'total_amount must be > 0', messageTh: 'จำนวนเงินต้องมากกว่าศูนย์' });
    if (!Number.isInteger(dto.months) || dto.months < 1) throw new BadRequestException({ code: 'BAD_MONTHS', message: 'months must be a positive integer', messageTh: 'จำนวนงวดต้องเป็นจำนวนเต็มบวก' });
    const tenantId = dto.tenantId ?? currentTenantStore()?.tenantId ?? user.tenantId ?? null;
    const start = dto.startDate ?? ymd();
    const scheduleNo = await this.docNo.nextDaily('PPD');
    const prepaidAcct = dto.prepaidAccount ?? '1280';
    // Optionally record the up-front prepayment (Dr 1280 prepaid / Cr 1000 cash) when not already on the books.
    if (dto.capitalize) {
      await this.postEntry({ date: start, source: 'PPD-CAP', sourceRef: scheduleNo, tenantId, memo: `Prepaid ${scheduleNo} — ${dto.name}`, createdBy: user.username, lines: [{ account_code: prepaidAcct, debit: total }, { account_code: '1000', credit: total }] });
    }
    const [r] = await db.insert(prepaidSchedules).values({
      scheduleNo, tenantId, name: dto.name, totalAmount: String(total), months: dto.months, amortizedAmount: '0', periodsPosted: 0,
      expenseAccount: dto.expenseAccount ?? '5100', prepaidAccount: prepaidAcct, startDate: start, nextRunDate: start, status: 'active', createdBy: user.username,
    }).returning({ id: prepaidSchedules.id });
    return { id: Number(r!.id), schedule_no: scheduleNo, name: dto.name, total_amount: total, months: dto.months, monthly_amount: round2(total / dto.months), next_run_date: start };
  }

  async listPrepaid(tenantId?: number) {
    const db = this.db;
    const where = tenantId != null ? eq(prepaidSchedules.tenantId, tenantId) : undefined;
    const rows = await db.select().from(prepaidSchedules).where(where).orderBy(desc(prepaidSchedules.id));
    return { schedules: rows.map((r: any) => ({ id: Number(r.id), schedule_no: r.scheduleNo, name: r.name, total_amount: n(r.totalAmount), months: Number(r.months), amortized_amount: n(r.amortizedAmount), remaining: round2(n(r.totalAmount) - n(r.amortizedAmount)), periods_posted: Number(r.periodsPosted), expense_account: r.expenseAccount, next_run_date: r.nextRunDate, status: r.status })), count: rows.length };
  }

  // Idempotent scheduled run: amortize one period of every active schedule whose next_run_date has arrived.
  async runDuePrepaid(user: JwtUser) {
    const db = this.db;
    const today = ymd();
    const due = await db.select().from(prepaidSchedules).where(and(eq(prepaidSchedules.status, 'active'), sql`${prepaidSchedules.nextRunDate} <= ${today}`));
    const posted: { entry_no: string | null; schedule_no: string; amount: number }[] = [];
    for (const r of due) {
      const total = n(r.totalAmount), months = Number(r.months), already = Number(r.periodsPosted);
      if (already >= months) { await db.update(prepaidSchedules).set({ status: 'complete' }).where(eq(prepaidSchedules.id, r.id)); continue; }
      const isLast = already === months - 1;
      const slice = isLast ? round2(total - n(r.amortizedAmount)) : round2(total / months);
      const period = String(today).slice(0, 7);
      const res = await this.postEntry({ date: today, source: 'PPD', sourceRef: `PPD-${Number(r.id)}-${period}`, tenantId: r.tenantId ?? null, memo: `Amortize prepaid ${r.scheduleNo} (${already + 1}/${months})`, createdBy: `${user?.username ?? 'system'} (prepaid)`, lines: [{ account_code: r.expenseAccount ?? '5100', debit: slice }, { account_code: r.prepaidAccount ?? '1280', credit: slice }] });
      const newPosted = already + 1;
      await db.update(prepaidSchedules).set({
        amortizedAmount: String(round2(n(r.amortizedAmount) + (res.entry_no ? slice : 0))),
        periodsPosted: newPosted, nextRunDate: addByFrequency(today, 'monthly'),
        status: newPosted >= months ? 'complete' : 'active',
      }).where(eq(prepaidSchedules.id, r.id));
      if (res.entry_no) posted.push({ entry_no: res.entry_no, schedule_no: r.scheduleNo, amount: slice });
    }
    return { as_of: today, scanned: due.length, posted: posted.length, entries: posted };
  }
}

// Recurring-journal cadence: the allowed frequencies and how each advances next_run_date.
const FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
function addByFrequency(dateStr: string, frequency: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (frequency === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (frequency === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCDate(d.getUTCDate() + 1); // daily (default)
  return d.toISOString().slice(0, 10);
}
