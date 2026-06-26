import { Inject, Injectable, NotFoundException, BadRequestException, Optional } from '@nestjs/common';
import { sql, eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { leases } from '../../database/schema';
import { journalEntries, journalLines } from '../../database/schema/ledger';
import { DocNumberService } from '../../common/doc-number.service';
import { LedgerService } from '../ledger/ledger.service';
import { currentTenantStore } from '../../common/tenant-context';
import { ymd, n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

export interface LeaseDto {
  name: string;
  lessor?: string;
  termMonths: number;
  monthlyPayment: number;
  annualRatePct?: number;
  tenantId?: number | null;
  startDate?: string;
}

export interface LeaseModifyDto {
  newMonthlyPayment?: number;
  newRemainingMonths?: number; // revised remaining term from now
  newAnnualRatePct?: number;
  effectiveDate?: string;
}

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
function addMonth(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}
// Present value of an ordinary annuity of `pmt` for `n` periods at periodic rate `r` (r=0 → pmt*n).
function presentValue(pmt: number, periods: number, r: number): number {
  if (r === 0) return pmt * periods;
  return pmt * (1 - Math.pow(1 + r, -periods)) / r;
}

// Lease accounting (IFRS 16 / TFRS 16) — control LSE-01.
@Injectable()
export class LeasesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    @Optional() private readonly ledger?: LedgerService,
  ) {}

  // At commencement: recognise the right-of-use asset + lease liability at the PV of the lease payments
  // (Dr 1600 / Cr 2600, non-cash).
  async createLease(dto: LeaseDto, user: JwtUser) {
    const db = this.db as any;
    if (!Number.isInteger(dto.termMonths) || dto.termMonths < 1) throw new BadRequestException({ code: 'BAD_TERM', message: 'term_months must be a positive integer', messageTh: 'จำนวนงวดต้องเป็นจำนวนเต็มบวก' });
    const pmt = round2(dto.monthlyPayment);
    if (!(pmt > 0)) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'monthly_payment must be > 0', messageTh: 'ค่าเช่าต้องมากกว่าศูนย์' });
    const ratePct = dto.annualRatePct ?? 0;
    const r = ratePct / 100 / 12;
    const liability = round2(presentValue(pmt, dto.termMonths, r));
    const tenantId = dto.tenantId ?? currentTenantStore()?.tenantId ?? user.tenantId ?? null;
    const start = dto.startDate ?? ymd();
    const leaseNo = await this.docNo.nextDaily('LSE');
    if (this.ledger) await this.ledger.postEntry({ date: start, source: 'LSE', sourceRef: leaseNo, tenantId, memo: `Lease commencement ${leaseNo} — ${dto.name}`, createdBy: user.username, lines: [{ account_code: '1600', debit: liability }, { account_code: '2600', credit: liability }] });
    const [l] = await db.insert(leases).values({
      leaseNo, tenantId, name: dto.name, lessor: dto.lessor ?? null, startDate: start, termMonths: dto.termMonths,
      monthlyPayment: String(pmt), annualRatePct: String(ratePct), initialLiability: String(liability), liabilityBalance: String(liability),
      rouNbv: String(liability), accumulatedDep: '0', periodsPosted: 0, nextRunDate: start, status: 'active', createdBy: user.username,
    }).returning({ id: leases.id });
    return { id: Number(l.id), lease_no: leaseNo, name: dto.name, term_months: dto.termMonths, monthly_payment: pmt, annual_rate_pct: ratePct, initial_liability: liability, rou_asset: liability, next_run_date: start };
  }

  // LSE-01 detective tie-out: the GL lease-liability control account (2600) must equal the sum of the
  // remaining liability balances on the lease schedule. A divergence means a manual JE hit 2600 outside the
  // lease engine, or a periodic run / remeasurement didn't post — surfaced for the controller at close.
  async reconcileLiability(tenantId?: number) {
    const db = this.db as any;
    const where = tenantId != null ? eq(leases.tenantId, tenantId) : undefined;
    const rows = await db.select().from(leases).where(where).orderBy(desc(leases.id));
    const scheduleLiability = round2(rows.reduce((s: number, l: any) => s + n(l.liabilityBalance), 0));

    const glConds = [eq(journalLines.accountCode, '2600'), eq(journalEntries.status, 'Posted')];
    if (tenantId != null) glConds.push(eq(journalEntries.tenantId, tenantId));
    const [g] = await db.select({
      credit: sql<string>`coalesce(sum(${journalLines.credit}),0)`,
      debit: sql<string>`coalesce(sum(${journalLines.debit}),0)`,
    }).from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id)).where(and(...glConds));
    const glLiability = round2(n(g?.credit ?? 0) - n(g?.debit ?? 0));
    const difference = round2(glLiability - scheduleLiability);

    return {
      gl_account: '2600', gl_liability: glLiability, schedule_liability: scheduleLiability,
      difference, reconciled: Math.abs(difference) < 0.01,
      leases: rows.map((l: any) => ({ lease_no: l.leaseNo, name: l.name, status: l.status, liability_balance: n(l.liabilityBalance), rou_nbv: n(l.rouNbv) })),
      count: rows.length,
    };
  }

  async listLeases(tenantId?: number) {
    const db = this.db as any;
    const where = tenantId != null ? eq(leases.tenantId, tenantId) : undefined;
    const rows = await db.select().from(leases).where(where).orderBy(desc(leases.id));
    return { leases: rows.map((l: any) => ({
      id: Number(l.id), lease_no: l.leaseNo, name: l.name, lessor: l.lessor, term_months: Number(l.termMonths),
      monthly_payment: n(l.monthlyPayment), annual_rate_pct: n(l.annualRatePct), initial_liability: n(l.initialLiability),
      liability_balance: n(l.liabilityBalance), accumulated_dep: n(l.accumulatedDep), rou_nbv: n(l.rouNbv),
      periods_posted: Number(l.periodsPosted), next_run_date: l.nextRunDate, status: l.status,
    })), count: rows.length };
  }

  // Idempotent periodic run: for each active lease whose next_run_date has arrived, post one period —
  // interest unwinding (Dr 5900), the cash payment reducing the liability (Dr 2600 / Cr 1000), and ROU
  // depreciation (Dr 5210 / Cr 1690). Last period clears the liability + ROU exactly.
  async runDueLeases(user: JwtUser) {
    const db = this.db as any;
    const today = ymd();
    const due = await db.select().from(leases).where(and(eq(leases.status, 'active'), sql`${leases.nextRunDate} <= ${today}`));
    const posted: { entry_no: string | null; lease_no: string; interest: number; principal: number; depreciation: number }[] = [];
    for (const l of due) {
      const term = Number(l.termMonths), already = Number(l.periodsPosted);
      if (already >= term) { await db.update(leases).set({ status: 'complete' }).where(eq(leases.id, l.id)); continue; }
      const isLast = already === term - 1;
      const r = n(l.annualRatePct) / 100 / 12;
      const liab = n(l.liabilityBalance);
      const interest = round2(liab * r);
      const principal = isLast ? round2(liab) : round2(n(l.monthlyPayment) - interest);
      const payment = round2(principal + interest);
      // ROU depreciation = straight-line over the REMAINING term on the current ROU NBV (so a remeasurement
      // from a modification is depreciated over what's left); the last period clears the ROU exactly.
      const rouNbv = n(l.rouNbv);
      const dep = isLast ? rouNbv : round2(rouNbv / (term - already));
      const period = String(today).slice(0, 7);
      const lines: any[] = [];
      if (interest > 0) lines.push({ account_code: '5900', debit: interest });
      lines.push({ account_code: '2600', debit: principal });
      if (dep > 0) lines.push({ account_code: '5210', debit: dep });
      lines.push({ account_code: '1000', credit: payment });
      if (dep > 0) lines.push({ account_code: '1690', credit: dep });
      const res = this.ledger
        ? await this.ledger.postEntry({ date: today, source: 'LSE-RUN', sourceRef: `LSE-${Number(l.id)}-${period}`, tenantId: l.tenantId ?? null, memo: `Lease ${l.leaseNo} period ${already + 1}/${term}`, createdBy: `${user?.username ?? 'system'} (lease)`, lines })
        : { entry_no: `LSE-${period}` };
      const newPosted = already + 1;
      await db.update(leases).set({
        liabilityBalance: String(round2(liab - principal)),
        rouNbv: String(round2(rouNbv - dep)),
        accumulatedDep: String(round2(n(l.accumulatedDep) + dep)),
        periodsPosted: newPosted, nextRunDate: addMonth(today),
        status: newPosted >= term ? 'complete' : 'active',
      }).where(eq(leases.id, l.id));
      if (res.entry_no) posted.push({ entry_no: res.entry_no, lease_no: l.leaseNo, interest, principal, depreciation: dep });
    }
    return { as_of: today, scanned: due.length, posted: posted.length, entries: posted };
  }

  // Lease modification / remeasurement (IFRS 16 §44–46): on a change to the payment, remaining term, or
  // rate, remeasure the lease liability at the PV of the revised payments and adjust the ROU asset by the
  // same amount (Dr/Cr 1600 ↔ 2600). If the downward remeasurement would take the ROU below zero, the ROU
  // is reduced to zero and the excess is recognised in P&L as a gain (Cr 1510). Depreciation then runs
  // straight-line over the revised remaining term.
  async modifyLease(leaseNo: string, dto: LeaseModifyDto, user: JwtUser) {
    const db = this.db as any;
    const [l] = await db.select().from(leases).where(eq(leases.leaseNo, leaseNo)).limit(1);
    if (!l) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Lease not found', messageTh: 'ไม่พบสัญญาเช่า' });
    if (l.status !== 'active') throw new BadRequestException({ code: 'NOT_ACTIVE', message: 'Lease is not active', messageTh: 'สัญญาเช่าไม่อยู่ในสถานะใช้งาน' });
    const already = Number(l.periodsPosted);
    const remainingOld = Number(l.termMonths) - already;
    const newRemaining = dto.newRemainingMonths ?? remainingOld;
    if (!Number.isInteger(newRemaining) || newRemaining < 1) throw new BadRequestException({ code: 'BAD_TERM', message: 'new_remaining_months must be a positive integer', messageTh: 'จำนวนงวดคงเหลือต้องเป็นจำนวนเต็มบวก' });
    const newPayment = round2(dto.newMonthlyPayment ?? n(l.monthlyPayment));
    if (!(newPayment > 0)) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'monthly_payment must be > 0', messageTh: 'ค่าเช่าต้องมากกว่าศูนย์' });
    const newRate = dto.newAnnualRatePct ?? n(l.annualRatePct);
    const r = newRate / 100 / 12;
    const newLiability = round2(presentValue(newPayment, newRemaining, r));
    const liabBefore = n(l.liabilityBalance);
    const rouBefore = n(l.rouNbv);
    const liabDelta = round2(newLiability - liabBefore);
    if (liabDelta === 0 && newRemaining === remainingOld && newPayment === n(l.monthlyPayment)) {
      throw new BadRequestException({ code: 'NO_CHANGE', message: 'modification does not change the lease', messageTh: 'การแก้ไขไม่เปลี่ยนแปลงสัญญาเช่า' });
    }
    const newRou = round2(rouBefore + liabDelta);
    const effective = dto.effectiveDate ?? ymd();
    const lines: any[] = [];
    let gain = 0;
    if (newRou >= 0) {
      // adjust both the liability and the ROU by the delta
      if (liabDelta > 0) { lines.push({ account_code: '1600', debit: liabDelta }, { account_code: '2600', credit: liabDelta }); }
      else { lines.push({ account_code: '2600', debit: -liabDelta }, { account_code: '1600', credit: -liabDelta }); }
    } else {
      // downward remeasurement larger than the ROU carrying amount → zero the ROU, excess is a P&L gain
      gain = round2(-newRou);
      lines.push({ account_code: '2600', debit: -liabDelta }); // reduce liability by |delta|
      if (rouBefore > 0) lines.push({ account_code: '1600', credit: rouBefore }); // reduce ROU to zero
      lines.push({ account_code: '1510', credit: gain }); // remeasurement gain to P&L
    }
    const je: any = this.ledger
      ? await this.ledger.postEntry({ date: effective, source: 'LSE-MOD', sourceRef: `LSE-${Number(l.id)}-MOD-${effective}-${newLiability}`, tenantId: l.tenantId ?? null, memo: `Lease ${leaseNo} remeasurement (liability ${liabBefore}→${newLiability})`, createdBy: user.username, lines })
      : { entry_no: `LSE-MOD-${effective}` };
    await db.update(leases).set({
      liabilityBalance: String(newLiability),
      rouNbv: String(Math.max(0, newRou)),
      monthlyPayment: String(newPayment),
      annualRatePct: String(newRate),
      termMonths: already + newRemaining, // remaining term from now = newRemaining
    }).where(eq(leases.id, l.id));
    return { lease_no: leaseNo, liability_before: liabBefore, liability_after: newLiability, liability_delta: liabDelta, rou_after: Math.max(0, newRou), remeasurement_gain: gain, new_remaining_months: newRemaining, journal_no: je?.entry_no ?? null };
  }
}
