import { Inject, Injectable, NotFoundException, BadRequestException, Optional } from '@nestjs/common';
import { sql, eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { leases } from '../../database/schema';
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
      accumulatedDep: '0', periodsPosted: 0, nextRunDate: start, status: 'active', createdBy: user.username,
    }).returning({ id: leases.id });
    return { id: Number(l.id), lease_no: leaseNo, name: dto.name, term_months: dto.termMonths, monthly_payment: pmt, annual_rate_pct: ratePct, initial_liability: liability, rou_asset: liability, next_run_date: start };
  }

  async listLeases(tenantId?: number) {
    const db = this.db as any;
    const where = tenantId != null ? eq(leases.tenantId, tenantId) : undefined;
    const rows = await db.select().from(leases).where(where).orderBy(desc(leases.id));
    return { leases: rows.map((l: any) => ({
      id: Number(l.id), lease_no: l.leaseNo, name: l.name, lessor: l.lessor, term_months: Number(l.termMonths),
      monthly_payment: n(l.monthlyPayment), annual_rate_pct: n(l.annualRatePct), initial_liability: n(l.initialLiability),
      liability_balance: n(l.liabilityBalance), accumulated_dep: n(l.accumulatedDep), rou_nbv: round2(n(l.initialLiability) - n(l.accumulatedDep)),
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
      const rou = n(l.initialLiability);
      const dep = isLast ? round2(rou - n(l.accumulatedDep)) : round2(rou / term);
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
        accumulatedDep: String(round2(n(l.accumulatedDep) + dep)),
        periodsPosted: newPosted, nextRunDate: addMonth(today),
        status: newPosted >= term ? 'complete' : 'active',
      }).where(eq(leases.id, l.id));
      if (res.entry_no) posted.push({ entry_no: res.entry_no, lease_no: l.leaseNo, interest, principal, depreciation: dep });
    }
    return { as_of: today, scanned: due.length, posted: posted.length, entries: posted };
  }
}
