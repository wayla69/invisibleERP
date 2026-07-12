import { Inject, Injectable, NotFoundException, BadRequestException, ForbiddenException, Optional } from '@nestjs/common';
import { eq, and, desc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { debtFacilities, debtDrawdowns, debtCovenants, debtCovenantTests } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { LedgerService } from '../ledger/ledger.service';
import { postingDefault } from '../ledger/posting-events';
import { currentTenantStore } from '../../common/tenant-context';
import { ymd, n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

// ── Debt & Borrowings register (Track C Wave 1) — TRE-01 + TRE-02 ─────────────────────────────────────────
// A facility is a credit line under maker-checker (create → PendingApproval; a DIFFERENT user approves →
// Approved; self-approve → 403 SOD_SELF_APPROVAL, mirroring FX-04 / TAX-11). A drawdown takes principal off an
// APPROVED facility, posting Dr 1010 Bank / Cr 2500 (short-term) or 2550 (long-term) Borrowings. Each drawdown
// carries an amortized-cost carrying amount (= its outstanding principal at par) and a periodic-run cursor
// (next_run_date / periods_posted) mirroring the lease engine (LSE-01). The idempotent EIR accrual posts one
// month of effective interest = carrying × EIR/12 (Dr 5900 Interest Expense / Cr 2450 Accrued Interest
// Payable) — re-running the same period is a no-op (the cursor has moved AND alreadyPosted guards the JE).
// Repayment clears principal (Dr 2500/2550) + accrued interest (Dr 2450) against cash (Cr 1010). TRE-02:
// covenant tests evaluate a supplied metric against its threshold/operator and persist breaches for a worklist.

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const round6 = (x: number) => Math.round((Number(x) || 0) * 1e6) / 1e6;
function addMonth(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00Z`).getTime();
  const db = new Date(`${b}T00:00:00Z`).getTime();
  return Math.round((db - da) / 86_400_000);
}
const OPERATORS = ['gte', 'lte', 'gt', 'lt'] as const;
type Operator = (typeof OPERATORS)[number];
// The direction that PASSES the covenant; a breach is the negation.
function passes(actual: number, op: Operator, threshold: number): boolean {
  switch (op) {
    case 'gte': return actual >= threshold;
    case 'lte': return actual <= threshold;
    case 'gt': return actual > threshold;
    case 'lt': return actual < threshold;
    default: return true;
  }
}

export interface FacilityDto {
  name: string;
  lender?: string;
  currency?: string;
  facilityType?: string;          // 'short_term' | 'long_term'
  limitAmount: number;
  eirPct?: number;                // effective annual interest rate %
  startDate?: string;
  maturityDate?: string;
  tenantId?: number | null;
}
export interface DrawdownDto {
  principal: number;
  ratePct?: number;               // override the facility EIR for this drawdown
  drawdownDate?: string;
}
export interface RepayDto {
  principal?: number;             // principal to repay (Dr 2500/2550)
  interest?: number;              // accrued interest to repay (Dr 2450)
  date?: string;
  drawdownId?: number;            // target a specific drawdown; default = oldest active
}
export interface CovenantDto {
  name: string;
  metric: string;
  operator?: string;              // gte | lte | gt | lt
  threshold: number;
  cadence?: string;
}
export interface CovenantTestItem { covenantId: number; value: number; note?: string }
export interface CovenantTestDto { asOf?: string; tests: CovenantTestItem[] }

@Injectable()
export class DebtService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    @Optional() private readonly ledger?: LedgerService,
  ) {}

  private tenant(explicit?: number | null, user?: JwtUser): number | null {
    if (explicit !== undefined && explicit !== null) return explicit;
    return currentTenantStore()?.tenantId ?? user?.tenantId ?? null;
  }
  // Short-term borrowings post to 2500, long-term to 2550 (registry defaults 2500; long-term overrides here).
  private borrowingsAccount(facilityType: string): string {
    return facilityType === 'short_term' ? postingDefault('DEBT.DRAWDOWN', 'borrowings') : '2550';
  }

  // ── Facilities — maker-checker (TRE-01) ────────────────────────────────────────────────────────────────
  async createFacility(dto: FacilityDto, user: JwtUser) {
    const db = this.db;
    const limit = round2(dto.limitAmount);
    if (!(limit > 0)) throw new BadRequestException({ code: 'BAD_LIMIT', message: 'limit_amount must be > 0', messageTh: 'วงเงินต้องมากกว่าศูนย์' });
    const ftype = dto.facilityType === 'short_term' ? 'short_term' : 'long_term';
    const eir = round6(dto.eirPct ?? 0);
    if (eir < 0) throw new BadRequestException({ code: 'BAD_RATE', message: 'eir_pct must be >= 0', messageTh: 'อัตราดอกเบี้ยต้องไม่ติดลบ' });
    const tenantId = this.tenant(dto.tenantId, user);
    const facilityNo = await this.docNo.nextDaily('DBTF');
    const [f] = await db.insert(debtFacilities).values({
      facilityNo, tenantId, name: dto.name, lender: dto.lender ?? null, currency: dto.currency ?? 'THB',
      facilityType: ftype, limitAmount: String(limit), eirPct: String(eir), startDate: dto.startDate ?? ymd(),
      maturityDate: dto.maturityDate ?? null, status: 'PendingApproval', drawnAmount: '0', outstandingPrincipal: '0',
      requestedBy: user.username, createdBy: user.username,
    }).returning({ id: debtFacilities.id });
    return this.getFacility(Number(f!.id));
  }

  // Checker: approve a PendingApproval facility (approver ≠ requester ⇒ SOD_SELF_APPROVAL, binds even Admin).
  async approveFacility(id: number, user: JwtUser) {
    const db = this.db;
    const f = await this.loadFacility(id);
    if (f.status !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Facility is ${f.status}, not pending approval`, messageTh: 'วงเงินไม่ได้อยู่ในสถานะรออนุมัติ' });
    if (f.requestedBy && f.requestedBy === user.username) {
      throw new ForbiddenException({ code: 'SOD_SELF_APPROVAL', message: 'Maker-checker: you cannot approve a debt facility you created', messageTh: 'ผู้สร้างอนุมัติวงเงินของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    }
    await db.update(debtFacilities).set({ status: 'Approved', approvedBy: user.username, approvedAt: new Date() }).where(eq(debtFacilities.id, id));
    return this.getFacility(id);
  }

  async rejectFacility(id: number, user: JwtUser) {
    const db = this.db;
    const f = await this.loadFacility(id);
    if (f.status !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Facility is ${f.status}, not pending approval`, messageTh: 'วงเงินไม่ได้อยู่ในสถานะรออนุมัติ' });
    await db.update(debtFacilities).set({ status: 'Rejected', approvedBy: user.username, approvedAt: new Date() }).where(eq(debtFacilities.id, id));
    return this.getFacility(id);
  }

  // ── Drawdown — Dr 1010 Bank / Cr 2500|2550 Borrowings (TRE-01) ──────────────────────────────────────────
  async drawdown(facilityId: number, dto: DrawdownDto, user: JwtUser) {
    const db = this.db;
    const f = await this.loadFacility(facilityId);
    if (f.status !== 'Approved') throw new BadRequestException({ code: 'FACILITY_NOT_APPROVED', message: 'Facility must be approved before a drawdown', messageTh: 'ต้องอนุมัติวงเงินก่อนเบิกใช้' });
    const principal = round2(dto.principal);
    if (!(principal > 0)) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'principal must be > 0', messageTh: 'จำนวนเงินเบิกต้องมากกว่าศูนย์' });
    const available = round2(n(f.limitAmount) - n(f.drawnAmount));
    if (principal > available + 0.001) {
      throw new BadRequestException({ code: 'LIMIT_EXCEEDED', message: `Drawdown ${principal} exceeds the available limit ${available}`, messageTh: 'จำนวนเงินเบิกเกินวงเงินคงเหลือ' });
    }
    const rate = round6(dto.ratePct ?? n(f.eirPct));
    const date = dto.drawdownDate ?? ymd();
    const drawdownNo = await this.docNo.nextDaily('DBTD');
    const borrowings = this.borrowingsAccount(f.facilityType);
    let entryNo: string | null = null;
    if (this.ledger) {
      const je: any = await this.ledger.postEntry({
        date, source: 'DEBT-DRAW', sourceRef: drawdownNo, tenantId: f.tenantId ?? null, currency: f.currency ?? 'THB',
        memo: `Drawdown ${drawdownNo} on facility ${f.facilityNo} — ${principal}`, createdBy: user.username,
        lines: [{ account_code: postingDefault('DEBT.DRAWDOWN', 'bank'), debit: principal }, { account_code: borrowings, credit: principal }],
      });
      entryNo = je?.entry_no ?? null;
    }
    const [d] = await db.insert(debtDrawdowns).values({
      drawdownNo, tenantId: f.tenantId ?? null, facilityId, drawdownDate: date, principal: String(principal),
      ratePct: String(rate), amortizedCost: String(principal), accruedInterest: '0', periodsPosted: 0,
      nextRunDate: addMonth(date), status: 'active', entryNo, createdBy: user.username,
    }).returning({ id: debtDrawdowns.id });
    await db.update(debtFacilities).set({
      drawnAmount: String(round2(n(f.drawnAmount) + principal)),
      outstandingPrincipal: String(round2(n(f.outstandingPrincipal) + principal)),
    }).where(eq(debtFacilities.id, facilityId));
    return { drawdown_no: drawdownNo, id: Number(d!.id), facility_no: f.facilityNo, principal, rate_pct: rate, amortized_cost: principal, borrowings_account: borrowings, next_run_date: addMonth(date), entry_no: entryNo };
  }

  // ── Idempotent EIR amortized-cost accrual (TRE-01) ──────────────────────────────────────────────────────
  // For each active drawdown of the facility whose next_run_date has arrived, post ONE month of effective
  // interest = round2(amortized_cost × EIR/100/12) → Dr 5900 / Cr 2450, advance the cursor, and stop at
  // maturity. Idempotent: the cursor moves a month per run AND alreadyPosted guards the per-period JE, so a
  // re-run of the same as-of posts nothing.
  async accrue(facilityId: number, user: JwtUser, asOf?: string) {
    const db = this.db;
    const f = await this.loadFacility(facilityId);
    const today = asOf ?? ymd();
    const due = await db.select().from(debtDrawdowns).where(and(
      eq(debtDrawdowns.facilityId, facilityId), eq(debtDrawdowns.status, 'active'), sql`${debtDrawdowns.nextRunDate} <= ${today}`,
    ));
    const posted: { drawdown_no: string; period: string; interest: number; entry_no: string | null }[] = [];
    for (const d of due) {
      const carrying = n(d.amortizedCost);
      const r = n(d.ratePct) / 100 / 12;
      const interest = round2(carrying * r);
      const period = String(d.nextRunDate ?? today).slice(0, 7);
      const sourceRef = `${d.drawdownNo}-${period}`;
      if (this.ledger && await this.ledger.alreadyPosted('DEBT-ACCR', sourceRef, f.tenantId ?? null)) {
        // already posted this period — just advance the cursor idempotently
        await db.update(debtDrawdowns).set({ nextRunDate: addMonth(String(d.nextRunDate ?? today)) }).where(eq(debtDrawdowns.id, d.id));
        continue;
      }
      let entryNo: string | null = null;
      if (this.ledger && interest > 0) {
        const je: any = await this.ledger.postEntry({
          date: String(d.nextRunDate ?? today), source: 'DEBT-ACCR', sourceRef, tenantId: f.tenantId ?? null, currency: f.currency ?? 'THB',
          memo: `EIR interest accrual ${d.drawdownNo} ${period}`, createdBy: `${user?.username ?? 'system'} (debt)`,
          lines: [{ account_code: postingDefault('DEBT.INTEREST', 'interest_exp'), debit: interest }, { account_code: postingDefault('DEBT.INTEREST', 'accrued_interest'), credit: interest }],
        });
        entryNo = je?.entry_no ?? null;
      }
      await db.update(debtDrawdowns).set({
        accruedInterest: String(round2(n(d.accruedInterest) + interest)),
        periodsPosted: Number(d.periodsPosted) + 1,
        nextRunDate: addMonth(String(d.nextRunDate ?? today)),
      }).where(eq(debtDrawdowns.id, d.id));
      posted.push({ drawdown_no: d.drawdownNo, period, interest, entry_no: entryNo });
    }
    return { facility_no: f.facilityNo, as_of: today, scanned: due.length, posted: posted.length, accruals: posted };
  }

  // ── Repayment — Dr 2500/2550 principal + Dr 2450 interest / Cr 1010 Bank (TRE-01) ───────────────────────
  async repay(facilityId: number, dto: RepayDto, user: JwtUser) {
    const db = this.db;
    const f = await this.loadFacility(facilityId);
    const repayPrincipal = round2(dto.principal ?? 0);
    const repayInterest = round2(dto.interest ?? 0);
    if (repayPrincipal < 0 || repayInterest < 0) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'amounts must be >= 0', messageTh: 'จำนวนเงินต้องไม่ติดลบ' });
    if (repayPrincipal === 0 && repayInterest === 0) throw new BadRequestException({ code: 'NOTHING_TO_REPAY', message: 'principal and interest are both zero', messageTh: 'ไม่มีจำนวนเงินที่จะชำระ' });
    // target drawdown: an explicit id, else the oldest active drawdown on the facility
    const active = await db.select().from(debtDrawdowns).where(and(eq(debtDrawdowns.facilityId, facilityId), eq(debtDrawdowns.status, 'active'))).orderBy(debtDrawdowns.id);
    const target = dto.drawdownId ? active.find((x: any) => Number(x.id) === dto.drawdownId) : active[0];
    if (!target) throw new BadRequestException({ code: 'NO_ACTIVE_DRAWDOWN', message: 'No active drawdown to repay', messageTh: 'ไม่มีรายการเบิกที่ค้างชำระ' });
    if (repayPrincipal > n(target.amortizedCost) + 0.001) throw new BadRequestException({ code: 'REPAY_EXCEEDS_PRINCIPAL', message: `Repayment ${repayPrincipal} exceeds the outstanding principal ${n(target.amortizedCost)}`, messageTh: 'จำนวนเงินชำระเกินเงินต้นคงเหลือ' });
    if (repayInterest > n(target.accruedInterest) + 0.001) throw new BadRequestException({ code: 'REPAY_EXCEEDS_INTEREST', message: `Interest repayment ${repayInterest} exceeds the accrued interest ${n(target.accruedInterest)}`, messageTh: 'จำนวนดอกเบี้ยที่ชำระเกินดอกเบี้ยค้างจ่าย' });
    const date = dto.date ?? ymd();
    const cash = round2(repayPrincipal + repayInterest);
    const borrowings = this.borrowingsAccount(f.facilityType);
    let entryNo: string | null = null;
    if (this.ledger) {
      const lines: any[] = [];
      if (repayPrincipal > 0) lines.push({ account_code: borrowings, debit: repayPrincipal });
      if (repayInterest > 0) lines.push({ account_code: postingDefault('DEBT.REPAY', 'accrued_interest'), debit: repayInterest });
      lines.push({ account_code: postingDefault('DEBT.REPAY', 'bank'), credit: cash });
      const je: any = await this.ledger.postEntry({
        date, source: 'DEBT-REPAY', sourceRef: `${target.drawdownNo}-REPAY-${date}-${cash}`, tenantId: f.tenantId ?? null, currency: f.currency ?? 'THB',
        memo: `Repayment ${target.drawdownNo} — principal ${repayPrincipal} + interest ${repayInterest}`, createdBy: user.username, lines,
      });
      entryNo = je?.entry_no ?? null;
    }
    const newCarrying = round2(n(target.amortizedCost) - repayPrincipal);
    await db.update(debtDrawdowns).set({
      amortizedCost: String(newCarrying),
      accruedInterest: String(round2(n(target.accruedInterest) - repayInterest)),
      status: newCarrying <= 0.001 ? 'repaid' : 'active',
    }).where(eq(debtDrawdowns.id, target.id));
    const newOutstanding = round2(n(f.outstandingPrincipal) - repayPrincipal);
    await db.update(debtFacilities).set({ outstandingPrincipal: String(newOutstanding < 0 ? 0 : newOutstanding) }).where(eq(debtFacilities.id, facilityId));
    return { facility_no: f.facilityNo, drawdown_no: target.drawdownNo, principal_repaid: repayPrincipal, interest_repaid: repayInterest, cash, remaining_principal: newCarrying, entry_no: entryNo };
  }

  // ── Maturity ladder — bucket outstanding principal by time-to-maturity (TRE-01 liquidity view) ──────────
  async maturityLadder(tenantId?: number | null, asOf?: string) {
    const db = this.db;
    const tid = this.tenant(tenantId);
    const today = asOf ?? ymd();
    const where = tid != null ? eq(debtFacilities.tenantId, tid) : undefined;
    const rows = await db.select().from(debtFacilities).where(where);
    const BUCKETS = [
      { key: '0-30d', maxDays: 30 }, { key: '31-90d', maxDays: 90 }, { key: '91-180d', maxDays: 180 },
      { key: '181-365d', maxDays: 365 }, { key: '>365d', maxDays: Infinity },
    ];
    const ladder: Record<string, { key: string; outstanding: number; facilities: number }> = {};
    for (const b of BUCKETS) ladder[b.key] = { key: b.key, outstanding: 0, facilities: 0 };
    let total = 0;
    for (const f of rows) {
      const outstanding = n(f.outstandingPrincipal);
      if (outstanding <= 0) continue;
      const days = f.maturityDate ? daysBetween(today, String(f.maturityDate)) : Infinity;
      const bucket = BUCKETS.find((b) => days <= b.maxDays) ?? BUCKETS[BUCKETS.length - 1]!;
      ladder[bucket.key]!.outstanding = round2(ladder[bucket.key]!.outstanding + outstanding);
      ladder[bucket.key]!.facilities += 1;
      total = round2(total + outstanding);
    }
    return { as_of: today, total_outstanding: total, buckets: BUCKETS.map((b) => ladder[b.key]!) };
  }

  async listFacilities(tenantId?: number | null) {
    const db = this.db;
    const tid = this.tenant(tenantId);
    const rows = await db.select().from(debtFacilities).where(tid != null ? eq(debtFacilities.tenantId, tid) : undefined).orderBy(desc(debtFacilities.id));
    return { facilities: rows.map(shapeFacility), count: rows.length };
  }

  async getFacility(id: number) {
    const f = await this.loadFacility(id);
    const db = this.db;
    const drawdowns = await db.select().from(debtDrawdowns).where(eq(debtDrawdowns.facilityId, id)).orderBy(debtDrawdowns.id);
    return { ...shapeFacility(f), drawdowns: drawdowns.map(shapeDrawdown) };
  }

  private async loadFacility(id: number) {
    const db = this.db;
    const [f] = await db.select().from(debtFacilities).where(eq(debtFacilities.id, id)).limit(1);
    if (!f) throw new NotFoundException({ code: 'FACILITY_NOT_FOUND', message: `Debt facility ${id} not found`, messageTh: `ไม่พบวงเงินสินเชื่อ ${id}` });
    return f;
  }

  // ── Covenants + breach detection (TRE-02) ──────────────────────────────────────────────────────────────
  async createCovenant(facilityId: number, dto: CovenantDto, user: JwtUser) {
    const db = this.db;
    const f = await this.loadFacility(facilityId);
    const op = (OPERATORS as readonly string[]).includes(dto.operator ?? '') ? dto.operator! : 'gte';
    const covenantNo = await this.docNo.nextDaily('DBTV');
    const [c] = await db.insert(debtCovenants).values({
      covenantNo, tenantId: f.tenantId ?? null, facilityId, name: dto.name, metric: dto.metric, operator: op,
      threshold: String(round6(dto.threshold)), cadence: dto.cadence ?? 'quarterly', status: 'active', createdBy: user.username,
    }).returning({ id: debtCovenants.id });
    const [row] = await db.select().from(debtCovenants).where(eq(debtCovenants.id, Number(c!.id))).limit(1);
    return shapeCovenant(row);
  }

  async listCovenants(tenantId?: number | null) {
    const db = this.db;
    const tid = this.tenant(tenantId);
    const rows = await db.select().from(debtCovenants).where(tid != null ? eq(debtCovenants.tenantId, tid) : undefined).orderBy(desc(debtCovenants.id));
    return { covenants: rows.map(shapeCovenant), count: rows.length };
  }

  // Detective breach monitor: evaluate each supplied covenant reading against its threshold/operator, persist a
  // test row (with breached flag), and surface the breaches. Recording the breach IS the detective control.
  async testCovenants(dto: CovenantTestDto, user: JwtUser) {
    const db = this.db;
    const asOf = dto.asOf ?? ymd();
    const results: any[] = [];
    for (const t of dto.tests ?? []) {
      const [c] = await db.select().from(debtCovenants).where(eq(debtCovenants.id, t.covenantId)).limit(1);
      if (!c) throw new NotFoundException({ code: 'COVENANT_NOT_FOUND', message: `Covenant ${t.covenantId} not found`, messageTh: `ไม่พบเงื่อนไขสัญญา ${t.covenantId}` });
      const actual = round6(t.value);
      const threshold = n(c.threshold);
      const breached = !passes(actual, c.operator as Operator, threshold);
      await db.insert(debtCovenantTests).values({
        tenantId: c.tenantId ?? null, covenantId: Number(c.id), facilityId: c.facilityId ?? null, asOf,
        metric: c.metric, operator: c.operator, threshold: String(threshold), actualValue: String(actual),
        breached, note: t.note ?? null, testedBy: user.username,
      });
      results.push({ covenant_id: Number(c.id), covenant_no: c.covenantNo, name: c.name, metric: c.metric, operator: c.operator, threshold, actual, breached });
    }
    const breaches = results.filter((r) => r.breached);
    return { as_of: asOf, tested: results.length, breached: breaches.length, results, breaches };
  }

  // TRE-02 worklist: outstanding breaches (the most recent test per covenant that is breached).
  async covenantBreaches(tenantId?: number | null) {
    const db = this.db;
    const tid = this.tenant(tenantId);
    const conds = [eq(debtCovenantTests.breached, true)];
    if (tid != null) conds.push(eq(debtCovenantTests.tenantId, tid));
    const rows = await db.select().from(debtCovenantTests)
      .where(and(...conds))
      .orderBy(desc(debtCovenantTests.asOf), desc(debtCovenantTests.id));
    const seen = new Set<number>();
    const latest = rows.filter((r: any) => { const k = Number(r.covenantId); if (seen.has(k)) return false; seen.add(k); return true; });
    return {
      breaches: latest.map((r: any) => ({ covenant_id: Number(r.covenantId), facility_id: r.facilityId ? Number(r.facilityId) : null, metric: r.metric, operator: r.operator, threshold: n(r.threshold), actual: n(r.actualValue), as_of: r.asOf, note: r.note })),
      count: latest.length,
    };
  }
}

function shapeFacility(f: any) {
  return {
    id: Number(f.id), facility_no: f.facilityNo, name: f.name, lender: f.lender, currency: f.currency,
    facility_type: f.facilityType, limit_amount: n(f.limitAmount), eir_pct: n(f.eirPct), start_date: f.startDate,
    maturity_date: f.maturityDate, status: f.status, drawn_amount: n(f.drawnAmount), outstanding_principal: n(f.outstandingPrincipal),
    available: round2(n(f.limitAmount) - n(f.drawnAmount)), requested_by: f.requestedBy, approved_by: f.approvedBy, created_by: f.createdBy,
  };
}
function shapeDrawdown(d: any) {
  return {
    id: Number(d.id), drawdown_no: d.drawdownNo, facility_id: Number(d.facilityId), drawdown_date: d.drawdownDate,
    principal: n(d.principal), rate_pct: n(d.ratePct), amortized_cost: n(d.amortizedCost), accrued_interest: n(d.accruedInterest),
    periods_posted: Number(d.periodsPosted), next_run_date: d.nextRunDate, status: d.status, entry_no: d.entryNo,
  };
}
function shapeCovenant(c: any) {
  return {
    id: Number(c.id), covenant_no: c.covenantNo, facility_id: c.facilityId ? Number(c.facilityId) : null, name: c.name,
    metric: c.metric, operator: c.operator, threshold: n(c.threshold), cadence: c.cadence, status: c.status,
  };
}
