import { Inject, Injectable, NotFoundException, BadRequestException, ForbiddenException, Optional } from '@nestjs/common';
import { sql, eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { lessorLeases } from '../../database/schema';
import { journalEntries, journalLines } from '../../database/schema/ledger';
import { DocNumberService } from '../../common/doc-number.service';
import { LedgerService } from '../ledger/ledger.service';
import { postingDefault } from '../ledger/posting-events';
import { currentTenantStore } from '../../common/tenant-context';
import { ymd, n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

export interface LessorLeaseDto {
  name: string;
  lessee?: string;
  termMonths: number;
  monthlyPayment: number;
  annualRatePct?: number;
  assetCost: number;            // underlying asset carrying amount at commencement
  fairValue?: number;           // fair value of the underlying asset (defaults to asset cost)
  economicLifeMonths?: number;  // asset economic life (defaults to the lease term)
  transferOwnership?: boolean;
  bargainPurchase?: boolean;
  tenantId?: number | null;
  startDate?: string;
}

// IFRS 16 lessor classification thresholds (the conventional "bright lines").
const MAJOR_PART_OF_LIFE = 0.75;      // lease term ≥ 75% of the asset's economic life
const SUBSTANTIALLY_ALL_FV = 0.90;    // PV of the lease payments ≥ 90% of the asset's fair value

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
function addMonth(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}
// Present value of an ordinary annuity of `pmt` for `periods` at periodic rate `r` (r=0 → pmt*periods).
function presentValue(pmt: number, periods: number, r: number): number {
  if (r === 0) return pmt * periods;
  return pmt * (1 - Math.pow(1 + r, -periods)) / r;
}

export interface LessorClassification {
  classification: 'finance' | 'operating';
  net_investment: number;    // PV of the lease payments
  pv_to_fair_value: number;  // PV / fair value ratio
  term_to_life: number;      // lease term / economic life ratio
  reasons: string[];
}

// Lessor-side lease accounting (IFRS 16 / TFRS 16) — control LSE-02. Classifies each lease finance vs
// operating and, for a FINANCE lease, derecognises the asset + books a net investment (lease receivable)
// with interest income unwound over the term; for an OPERATING lease keeps the asset with straight-line
// rental income + continued depreciation. Classification + commencement is maker-checker (creator ≠ approver).
@Injectable()
export class LessorLeasesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    @Optional() private readonly ledger?: LedgerService,
  ) {}

  // IFRS 16 lessor classification: a lease is a FINANCE lease if it transfers substantially all the risks and
  // rewards incidental to ownership — evidenced by ANY of: transfer of ownership by the end of the term, a
  // bargain purchase option, the lease term being a major part of the asset's economic life, or the PV of the
  // lease payments amounting to substantially all of the asset's fair value. Otherwise it is an OPERATING lease.
  classify(dto: LessorLeaseDto): LessorClassification {
    const pmt = round2(dto.monthlyPayment);
    const r = (dto.annualRatePct ?? 0) / 100 / 12;
    const pv = round2(presentValue(pmt, dto.termMonths, r));
    const fairValue = round2(dto.fairValue ?? dto.assetCost ?? pv);
    const economicLife = dto.economicLifeMonths && dto.economicLifeMonths > 0 ? dto.economicLifeMonths : dto.termMonths;
    const termToLife = economicLife > 0 ? dto.termMonths / economicLife : 0;
    const pvToFv = fairValue > 0 ? pv / fairValue : 0;
    const reasons: string[] = [];
    if (dto.transferOwnership) reasons.push('transfer_of_ownership');
    if (dto.bargainPurchase) reasons.push('bargain_purchase_option');
    if (termToLife >= MAJOR_PART_OF_LIFE) reasons.push('major_part_of_economic_life');
    if (pvToFv >= SUBSTANTIALLY_ALL_FV) reasons.push('pv_substantially_all_fair_value');
    return {
      classification: reasons.length > 0 ? 'finance' : 'operating',
      net_investment: pv, pv_to_fair_value: round2(pvToFv), term_to_life: round2(termToLife), reasons,
    };
  }

  // Preview the classification without persisting — lets the lessor see finance vs operating before committing.
  previewClassification(dto: LessorLeaseDto) {
    if (!Number.isInteger(dto.termMonths) || dto.termMonths < 1) throw new BadRequestException({ code: 'BAD_TERM', message: 'term_months must be a positive integer', messageTh: 'จำนวนงวดต้องเป็นจำนวนเต็มบวก' });
    if (!(round2(dto.monthlyPayment) > 0)) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'monthly_payment must be > 0', messageTh: 'ค่าเช่าต้องมากกว่าศูนย์' });
    return this.classify(dto);
  }

  // Create the lessor lease as PENDING (classification proposed, NO GL yet). A DIFFERENT user must approve it
  // (maker-checker, SoD) before commencement posts — LSE-02.
  async createLease(dto: LessorLeaseDto, user: JwtUser) {
    const db = this.db;
    if (!Number.isInteger(dto.termMonths) || dto.termMonths < 1) throw new BadRequestException({ code: 'BAD_TERM', message: 'term_months must be a positive integer', messageTh: 'จำนวนงวดต้องเป็นจำนวนเต็มบวก' });
    const pmt = round2(dto.monthlyPayment);
    if (!(pmt > 0)) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'monthly_payment must be > 0', messageTh: 'ค่าเช่าต้องมากกว่าศูนย์' });
    const assetCost = round2(dto.assetCost);
    if (!(assetCost > 0)) throw new BadRequestException({ code: 'BAD_ASSET_COST', message: 'asset_cost must be > 0', messageTh: 'มูลค่าสินทรัพย์ต้องมากกว่าศูนย์' });
    const ratePct = dto.annualRatePct ?? 0;
    const cls = this.classify(dto);
    const tenantId = dto.tenantId ?? currentTenantStore()?.tenantId ?? user.tenantId ?? null;
    const start = dto.startDate ?? ymd();
    const leaseNo = await this.docNo.nextDaily('LSR');
    const [l] = await db.insert(lessorLeases).values({
      leaseNo, tenantId, name: dto.name, lessee: dto.lessee ?? null, startDate: start, termMonths: dto.termMonths,
      monthlyPayment: String(pmt), annualRatePct: String(ratePct), assetCost: String(assetCost),
      fairValue: String(round2(dto.fairValue ?? assetCost)), economicLifeMonths: dto.economicLifeMonths ?? null,
      transferOwnership: !!dto.transferOwnership, bargainPurchase: !!dto.bargainPurchase, classification: cls.classification,
      netInvestment: String(cls.net_investment), receivableBalance: '0', accumulatedDep: '0',
      periodsPosted: 0, nextRunDate: start, status: 'pending', createdBy: user.username,
    }).returning({ id: lessorLeases.id });
    return {
      id: Number(l!.id), lease_no: leaseNo, name: dto.name, lessee: dto.lessee ?? null, term_months: dto.termMonths,
      monthly_payment: pmt, annual_rate_pct: ratePct, asset_cost: assetCost, classification: cls.classification,
      net_investment: cls.net_investment, pv_to_fair_value: cls.pv_to_fair_value, term_to_life: cls.term_to_life,
      reasons: cls.reasons, status: 'pending',
    };
  }

  // Maker-checker approval (LSE-02): a DIFFERENT user approves the classification, which posts commencement.
  // FINANCE: derecognise the asset (Cr 1500 assetCost), book the net investment (Dr 1610 PV), selling
  //          profit/loss to 1510. OPERATING: no commencement GL — the asset stays on the lessor's books.
  async approveLease(leaseNo: string, approver: JwtUser) {
    const db = this.db;
    const [l] = await db.select().from(lessorLeases).where(eq(lessorLeases.leaseNo, leaseNo)).limit(1);
    if (!l) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Lessor lease not found', messageTh: 'ไม่พบสัญญาเช่า (ผู้ให้เช่า)' });
    if (l.status !== 'pending') throw new BadRequestException({ code: 'NOT_PENDING', message: 'Lease is not pending approval', messageTh: 'สัญญาเช่าไม่อยู่ระหว่างรออนุมัติ' });
    if (l.createdBy && approver.username && l.createdBy === approver.username) {
      throw new ForbiddenException({ code: 'SOD_SELF_APPROVAL', message: 'The classifier cannot approve their own lessor lease', messageTh: 'ผู้จัดประเภทไม่สามารถอนุมัติสัญญาเช่าของตนเองได้' });
    }
    const start = l.startDate ?? ymd();
    const assetCost = n(l.assetCost);
    const pv = n(l.netInvestment);
    let journalNo: string | null = null;
    if (l.classification === 'finance') {
      const diff = round2(pv - assetCost); // >0 selling profit (credit), <0 selling loss (debit)
      // docs/43 PR-3: the selling-P&L leg follows the tenant posting-rule (LEASE.LESSOR_COMMENCE) ??
      // registry default; the net-investment (1610, LSE-02 tie) and asset (1500) controls stay pinned.
      const plAcct = (this.ledger ? (await this.ledger.postingOverrides('LEASE.LESSOR_COMMENCE', l.tenantId ?? null)).selling_pl : undefined)
        ?? postingDefault('LEASE.LESSOR_COMMENCE', 'selling_pl');
      const lines: { account_code: string; debit?: number; credit?: number }[] = [{ account_code: '1610', debit: pv }, { account_code: '1500', credit: assetCost }];
      if (diff > 0) lines.push({ account_code: plAcct, credit: diff });
      else if (diff < 0) lines.push({ account_code: plAcct, debit: -diff });
      const je: { entry_no?: string | null } = this.ledger
        ? await this.ledger.postEntry({ date: start, source: 'LSR', sourceRef: leaseNo, tenantId: l.tenantId ?? null, memo: `Finance lease commencement ${leaseNo} — ${l.name} (net investment ${pv})`, createdBy: approver.username, lines })
        : { entry_no: `LSR-${start}` };
      journalNo = je.entry_no ?? null;
    }
    const bookedReceivable = l.classification === 'finance' ? pv : 0; // operating keeps the asset — no receivable booked
    await db.update(lessorLeases).set({
      status: 'active', approvedBy: approver.username,
      receivableBalance: String(bookedReceivable),
      nextRunDate: start,
    }).where(eq(lessorLeases.id, l.id));
    return { lease_no: leaseNo, classification: l.classification, status: 'active', net_investment: bookedReceivable, asset_cost: assetCost, journal_no: journalNo };
  }

  async listLeases(tenantId?: number) {
    const db = this.db;
    const where = tenantId != null ? eq(lessorLeases.tenantId, tenantId) : undefined;
    const rows = await db.select().from(lessorLeases).where(where).orderBy(desc(lessorLeases.id));
    return { leases: rows.map((l) => ({
      id: Number(l.id), lease_no: l.leaseNo, name: l.name, lessee: l.lessee, term_months: Number(l.termMonths),
      monthly_payment: n(l.monthlyPayment), annual_rate_pct: n(l.annualRatePct), asset_cost: n(l.assetCost),
      classification: l.classification, net_investment: n(l.netInvestment), receivable_balance: n(l.receivableBalance),
      interest_income_recognized: n(l.interestIncomeRecognized), accumulated_dep: n(l.accumulatedDep),
      rental_income_recognized: n(l.rentalIncomeRecognized), periods_posted: Number(l.periodsPosted),
      next_run_date: l.nextRunDate, status: l.status, created_by: l.createdBy, approved_by: l.approvedBy,
    })), count: rows.length };
  }

  // Idempotent periodic run: for each ACTIVE lessor lease whose next_run_date has arrived, post one period.
  //   FINANCE: interest income on the net investment (Cr 4600) + cash collected (Dr 1000), the principal
  //            portion reducing the receivable (Cr 1610); the last period clears the receivable exactly.
  //   OPERATING: straight-line rental income (Dr 1000 / Cr 4610) + continued asset depreciation
  //            (Dr 5200 / Cr 1590) over the asset's economic life.
  async runDueLeases(user: JwtUser) {
    const db = this.db;
    const today = ymd();
    const due = await db.select().from(lessorLeases).where(and(eq(lessorLeases.status, 'active'), sql`${lessorLeases.nextRunDate} <= ${today}`));
    const posted: { entry_no: string | null; lease_no: string; classification: string; interest_income: number; principal: number; rental_income: number; depreciation: number }[] = [];
    for (const l of due) {
      const term = Number(l.termMonths), already = Number(l.periodsPosted);
      if (already >= term) { await db.update(lessorLeases).set({ status: 'complete' }).where(eq(lessorLeases.id, l.id)); continue; }
      const isLast = already === term - 1;
      const period = String(today).slice(0, 7);
      const lines: { account_code: string; debit?: number; credit?: number }[] = [];
      let interestIncome = 0, principal = 0, rentalIncome = 0, dep = 0;
      const set: Record<string, unknown> = {};
      if (l.classification === 'finance') {
        const r = n(l.annualRatePct) / 100 / 12;
        const recv = n(l.receivableBalance);
        interestIncome = round2(recv * r);
        principal = isLast ? round2(recv) : round2(n(l.monthlyPayment) - interestIncome);
        const cashIn = round2(principal + interestIncome);
        // docs/43 PR-3: income leg follows the tenant posting-rule (LEASE.LESSOR_FINANCE) ?? default.
        const intAcct = (this.ledger ? (await this.ledger.postingOverrides('LEASE.LESSOR_FINANCE', l.tenantId ?? null)).interest_income : undefined)
          ?? postingDefault('LEASE.LESSOR_FINANCE', 'interest_income');
        lines.push({ account_code: '1000', debit: cashIn });
        if (interestIncome > 0) lines.push({ account_code: intAcct, credit: interestIncome });
        lines.push({ account_code: '1610', credit: principal });
        set.receivableBalance = String(round2(recv - principal));
        set.interestIncomeRecognized = String(round2(n(l.interestIncomeRecognized) + interestIncome));
      } else {
        rentalIncome = round2(n(l.monthlyPayment)); // straight-line rental income (level payments)
        const life = l.economicLifeMonths && Number(l.economicLifeMonths) > 0 ? Number(l.economicLifeMonths) : term;
        const remainingDep = round2(n(l.assetCost) - n(l.accumulatedDep));
        dep = Math.min(round2(n(l.assetCost) / life), remainingDep);
        if (dep < 0) dep = 0;
        // docs/43 PR-3: rental-income + depreciation-expense legs follow the tenant posting-rules
        // (LEASE.LESSOR_OPERATING) ?? defaults; cash (1000) and accum-dep (1590) stay pinned.
        const opOvr = this.ledger ? await this.ledger.postingOverrides('LEASE.LESSOR_OPERATING', l.tenantId ?? null) : {} as Record<string, string>;
        lines.push({ account_code: '1000', debit: rentalIncome }, { account_code: opOvr.rental_income ?? postingDefault('LEASE.LESSOR_OPERATING', 'rental_income'), credit: rentalIncome });
        if (dep > 0) lines.push({ account_code: opOvr.dep_expense ?? postingDefault('LEASE.LESSOR_OPERATING', 'dep_expense'), debit: dep }, { account_code: '1590', credit: dep });
        set.accumulatedDep = String(round2(n(l.accumulatedDep) + dep));
        set.rentalIncomeRecognized = String(round2(n(l.rentalIncomeRecognized) + rentalIncome));
      }
      const res: { entry_no?: string | null } = this.ledger
        ? await this.ledger.postEntry({ date: today, source: 'LSR-RUN', sourceRef: `LSR-${Number(l.id)}-${period}`, tenantId: l.tenantId ?? null, memo: `Lessor lease ${l.leaseNo} period ${already + 1}/${term} (${l.classification})`, createdBy: `${user?.username ?? 'system'} (lessor lease)`, lines })
        : { entry_no: `LSR-${period}` };
      const newPosted = already + 1;
      await db.update(lessorLeases).set({ ...set, periodsPosted: newPosted, nextRunDate: addMonth(today), status: newPosted >= term ? 'complete' : 'active' }).where(eq(lessorLeases.id, l.id));
      if (res.entry_no) posted.push({ entry_no: res.entry_no, lease_no: l.leaseNo, classification: l.classification, interest_income: interestIncome, principal, rental_income: rentalIncome, depreciation: dep });
    }
    return { as_of: today, scanned: due.length, posted: posted.length, entries: posted };
  }

  // LSE-02 detective tie-out: the GL net-investment control account (1610) must equal the sum of the
  // remaining receivable balances on the FINANCE-lease schedule. A divergence means a manual JE hit 1610
  // outside the lessor engine, or a periodic run didn't post — surfaced for the controller at close.
  async reconcileReceivable(tenantId?: number) {
    const db = this.db;
    const where = tenantId != null ? eq(lessorLeases.tenantId, tenantId) : undefined;
    const rows = await db.select().from(lessorLeases).where(where).orderBy(desc(lessorLeases.id));
    const scheduleReceivable = round2(rows.filter((l) => l.classification === 'finance').reduce((s: number, l) => s + n(l.receivableBalance), 0));

    const glConds = [eq(journalLines.accountCode, '1610'), eq(journalEntries.status, 'Posted')];
    if (tenantId != null) glConds.push(eq(journalEntries.tenantId, tenantId));
    const [g] = await db.select({
      debit: sql<string>`coalesce(sum(${journalLines.debit}),0)`,
      credit: sql<string>`coalesce(sum(${journalLines.credit}),0)`,
    }).from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id)).where(and(...glConds));
    const glReceivable = round2(n(g?.debit ?? 0) - n(g?.credit ?? 0));
    const difference = round2(glReceivable - scheduleReceivable);
    return {
      gl_account: '1610', gl_receivable: glReceivable, schedule_receivable: scheduleReceivable,
      difference, reconciled: Math.abs(difference) < 0.01,
      leases: rows.map((l) => ({ lease_no: l.leaseNo, name: l.name, classification: l.classification, status: l.status, receivable_balance: n(l.receivableBalance) })),
      count: rows.length,
    };
  }
}
