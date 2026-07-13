import { Inject, Injectable, NotFoundException, BadRequestException, ForbiddenException, Optional } from '@nestjs/common';
import { eq, and, desc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { cashPools, cashPoolMembers, icLoans, icLoanAccruals } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { LedgerService } from '../ledger/ledger.service';
import { LedgerReadService } from '../ledger/ledger-read.service';
import { postingDefault } from '../ledger/posting-events';
import { currentTenantStore } from '../../common/tenant-context';
import { ymd, n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

// ── Cash pooling / in-house bank / intercompany-loan register (Track C Wave 4) — control TRE-05 ─────────────────
// THREE surfaces on one spine (see schema/treasury-pool.ts). The CONTROL CORE is the consolidation-elimination
// integrity: an IC loan's 1155/2155 receivable/payable pair AND its 4700/5900 interest ELIMINATE at the group
// layer (extended in consolidation.service.runConsolidation), mirroring the trade-IC 1150/2150 pair, so group
// balances and group finance cost/income net to zero. IC loans are maker-checker (register → PendingApproval; a
// DIFFERENT user approves → the mirrored drawdown posts; self-approve → 403 SOD_SELF_APPROVAL). Interest accrues
// on the effective-interest amortized-cost carrying, reusing the Wave-1 periodic cursor + alreadyPosted
// idempotency. Every posting routes through LedgerService.postEntry (GL-05 balanced + period lock). Tenant-scoped
// (RLS + explicit tenant filter); the maker/checker duties are the Wave-1 treasury / treasury_approve pair.

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const round6 = (x: number) => Math.round((Number(x) || 0) * 1e6) / 1e6;
function addMonth(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

export interface PoolMemberDto { memberAccount: string; memberTenantId?: number | null; cap?: number }
export interface PoolDto {
  name: string;
  poolType?: string;               // notional | physical
  headerAccount: string;
  currency?: string;
  members?: PoolMemberDto[];
  tenantId?: number | null;
}
export interface SweepDto { memberAccount: string; amount: number; date?: string }
export interface AllocationItem { memberAccount?: string; amount: number }
export interface AllocateDto { allocations: AllocationItem[]; date?: string }
export interface IcLoanDto {
  creditorTenantId: number;
  debtorTenantId: number;
  principal: number;
  eirPct?: number;
  startDate?: string;
  currency?: string;
}

@Injectable()
export class PoolService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    @Optional() private readonly ledger?: LedgerService,
    // docs/46 Phase 3 — GL balances come from the ledger's narrow read API instead of a direct
    // journal_lines⋈journal_entries join here. Appended @Optional (positional-construction convention).
    @Optional() private readonly ledgerRead?: LedgerReadService,
  ) {}

  private tenant(explicit?: number | null, user?: JwtUser): number | null {
    if (explicit !== undefined && explicit !== null) return explicit;
    return currentTenantStore()?.tenantId ?? user?.tenantId ?? null;
  }

  // ── Cash pool definition (maker, treasury) ──────────────────────────────────────────────────────────────
  async definePool(dto: PoolDto, user: JwtUser) {
    const db = this.db;
    const poolType = dto.poolType === 'physical' ? 'physical' : 'notional';
    if (!dto.headerAccount || !dto.headerAccount.trim()) throw new BadRequestException({ code: 'BAD_HEADER_ACCOUNT', message: 'header_account is required', messageTh: 'ต้องระบุบัญชีหลักของกลุ่มเงินสด' });
    const tenantId = this.tenant(dto.tenantId, user);
    const poolNo = await this.docNo.nextDaily('POOL');
    const [p] = await db.insert(cashPools).values({
      poolNo, tenantId, name: dto.name, poolType, headerAccount: dto.headerAccount.trim(),
      currency: dto.currency ?? 'THB', status: 'active', createdBy: user.username,
    }).returning({ id: cashPools.id });
    const poolId = Number(p!.id);
    for (const m of dto.members ?? []) {
      if (!m.memberAccount || !m.memberAccount.trim()) throw new BadRequestException({ code: 'BAD_MEMBER_ACCOUNT', message: 'member_account is required', messageTh: 'ต้องระบุบัญชีสมาชิก' });
      await db.insert(cashPoolMembers).values({
        tenantId, poolId, memberTenantId: m.memberTenantId ?? tenantId, memberAccount: m.memberAccount.trim(),
        cap: String(round2(m.cap ?? 0)), createdBy: user.username,
      });
    }
    return this.getPool(poolId);
  }

  // ── Physical sweep — Dr header-bank / Cr member-bank (TRE-05) ────────────────────────────────────────────
  async sweep(poolId: number, dto: SweepDto, user: JwtUser) {
    const db = this.db;
    const pool = await this.loadPool(poolId);
    if (pool.poolType !== 'physical') throw new BadRequestException({ code: 'NOT_PHYSICAL_POOL', message: 'Only a physical pool sweeps cash; a notional pool allocates interest', messageTh: 'เฉพาะกลุ่มเงินสดแบบโอนจริงจึงกวาดยอดได้' });
    const amount = round2(dto.amount);
    if (!(amount > 0)) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'amount must be > 0', messageTh: 'จำนวนเงินต้องมากกว่าศูนย์' });
    const [member] = await db.select().from(cashPoolMembers).where(and(eq(cashPoolMembers.poolId, poolId), eq(cashPoolMembers.memberAccount, dto.memberAccount))).limit(1);
    if (!member) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: `Pool member account ${dto.memberAccount} not found`, messageTh: 'ไม่พบบัญชีสมาชิกในกลุ่ม' });
    const date = dto.date ?? ymd();
    let entryNo: string | null = null;
    if (this.ledger) {
      // The pool's own header/member GL accounts drive the legs (POOL.SWEEP registry defaults 1010/1020).
      const je: any = await this.ledger.postEntry({
        date, source: 'POOL-SWEEP', sourceRef: `${pool.poolNo}-${date}-${amount}`, tenantId: pool.tenantId ?? null, currency: pool.currency ?? 'THB',
        memo: `Physical sweep ${pool.poolNo} — ${dto.memberAccount} → header ${pool.headerAccount} ${amount}`, createdBy: user.username,
        lines: [{ account_code: pool.headerAccount, debit: amount }, { account_code: dto.memberAccount, credit: amount }],
      });
      entryNo = je?.entry_no ?? null;
    }
    return { pool_no: pool.poolNo, header_account: pool.headerAccount, member_account: dto.memberAccount, amount, date, entry_no: entryNo };
  }

  // ── Notional interest allocation — MUST sum to zero (TRE-05) ─────────────────────────────────────────────
  // A pure internal redistribution of the pooled interest benefit/cost: a surplus member earns 4700 interest
  // income, a deficit member bears 5900 interest expense, and because Σ allocations = 0 the JE self-balances
  // (Σ 4700 credits = Σ 5900 debits) — the group's net P&L on the pool is zero. The zero-sum IS the control.
  async allocateInterest(poolId: number, dto: AllocateDto, user: JwtUser) {
    const pool = await this.loadPool(poolId);
    if (pool.poolType !== 'notional') throw new BadRequestException({ code: 'NOT_NOTIONAL_POOL', message: 'Only a notional pool allocates interest; a physical pool sweeps cash', messageTh: 'เฉพาะกลุ่มเงินสดแบบทฤษฎีจึงปันส่วนดอกเบี้ยได้' });
    const allocations = (dto.allocations ?? []).map((a) => ({ memberAccount: a.memberAccount ?? null, amount: round2(a.amount) }));
    if (!allocations.some((a) => a.amount !== 0)) throw new BadRequestException({ code: 'EMPTY_ALLOCATION', message: 'at least one non-zero allocation is required', messageTh: 'ต้องมีการปันส่วนอย่างน้อยหนึ่งรายการ' });
    const sum = round2(allocations.reduce((a, x) => a + x.amount, 0));
    if (Math.abs(sum) > 0.01) throw new BadRequestException({ code: 'ALLOCATION_NOT_ZERO', message: `Notional interest allocation must sum to zero (got ${sum})`, messageTh: `การปันส่วนดอกเบี้ยแบบทฤษฎีต้องรวมเป็นศูนย์ (ได้ ${sum})` });
    const date = dto.date ?? ymd();
    const incomeAcct = postingDefault('POOL.INTEREST', 'interest_income'); // 4700
    const expenseAcct = postingDefault('POOL.INTEREST', 'interest_exp');   // 5900
    const lines: any[] = [];
    for (const a of allocations) {
      if (a.amount > 0) lines.push({ account_code: incomeAcct, credit: a.amount });
      else if (a.amount < 0) lines.push({ account_code: expenseAcct, debit: -a.amount });
    }
    let entryNo: string | null = null;
    if (this.ledger && lines.length) {
      const je: any = await this.ledger.postEntry({
        date, source: 'POOL-ALLOC', sourceRef: `${pool.poolNo}-ALLOC-${date}`, tenantId: pool.tenantId ?? null, currency: pool.currency ?? 'THB',
        memo: `Notional interest allocation ${pool.poolNo} ${date} (zero-sum)`, createdBy: user.username, lines,
      });
      entryNo = je?.entry_no ?? null;
    }
    return { pool_no: pool.poolNo, date, allocation_sum: sum, allocations, entry_no: entryNo };
  }

  async getPool(poolId: number) {
    const db = this.db;
    const pool = await this.loadPool(poolId);
    const members = await db.select().from(cashPoolMembers).where(eq(cashPoolMembers.poolId, poolId)).orderBy(cashPoolMembers.id);
    return { ...shapePool(pool), members: members.map(shapeMember) };
  }

  async listPools(tenantId?: number | null) {
    const db = this.db;
    const tid = this.tenant(tenantId);
    const rows = await db.select().from(cashPools).where(tid != null ? eq(cashPools.tenantId, tid) : undefined).orderBy(desc(cashPools.id));
    return { pools: rows.map(shapePool), count: rows.length };
  }

  // ── Pool position — header + member GL balances + net notional position ──────────────────────────────────
  async poolPosition(poolId: number, user: JwtUser, asOf?: string) {
    const db = this.db;
    const pool = await this.loadPool(poolId);
    const members = await db.select().from(cashPoolMembers).where(eq(cashPoolMembers.poolId, poolId)).orderBy(cashPoolMembers.id);
    const tid = pool.tenantId ?? this.tenant(undefined, user);
    const today = asOf ?? ymd();
    const balanceOf = async (account: string): Promise<number> => {
      if (!this.ledgerRead) throw new BadRequestException({ code: 'LEDGER_UNAVAILABLE', message: 'Ledger read service not available', messageTh: 'ระบบบัญชีแยกประเภทไม่พร้อมใช้งาน' });
      return round2(await this.ledgerRead.accountNet([account], { tenantId: tid, asOf: today }));
    };
    const headerBalance = await balanceOf(pool.headerAccount);
    const memberPos: { member_account: string; member_tenant_id: number | null; cap: number; balance: number }[] = [];
    let notional = 0;
    for (const m of members) {
      const bal = await balanceOf(m.memberAccount);
      memberPos.push({ member_account: m.memberAccount, member_tenant_id: m.memberTenantId ? Number(m.memberTenantId) : null, cap: n(m.cap), balance: bal });
      notional = round2(notional + bal);
    }
    return {
      pool_no: pool.poolNo, pool_type: pool.poolType, header_account: pool.headerAccount, as_of: today,
      header_balance: headerBalance, members: memberPos,
      net_notional_position: round2(headerBalance + notional),
    };
  }

  // ── IC loan register — maker-checker (TRE-05) ────────────────────────────────────────────────────────────
  async registerLoan(dto: IcLoanDto, user: JwtUser) {
    const db = this.db;
    const principal = round2(dto.principal);
    if (!(principal > 0)) throw new BadRequestException({ code: 'BAD_PRINCIPAL', message: 'principal must be > 0', messageTh: 'เงินต้นต้องมากกว่าศูนย์' });
    if (dto.creditorTenantId === dto.debtorTenantId) throw new BadRequestException({ code: 'SAME_PARTY', message: 'creditor and debtor must differ', messageTh: 'ผู้ให้กู้และผู้กู้ต้องต่างกัน' });
    const eir = round6(dto.eirPct ?? 0);
    if (eir < 0) throw new BadRequestException({ code: 'BAD_RATE', message: 'eir_pct must be >= 0', messageTh: 'อัตราดอกเบี้ยต้องไม่ติดลบ' });
    const startDate = dto.startDate ?? ymd();
    const loanNo = await this.docNo.nextDaily('ICLN');
    const [row] = await db.insert(icLoans).values({
      loanNo, tenantId: dto.creditorTenantId, creditorTenantId: dto.creditorTenantId, debtorTenantId: dto.debtorTenantId,
      principal: String(principal), eirPct: String(eir), carrying: '0', accruedInterest: '0', currency: dto.currency ?? 'THB',
      startDate, nextRunDate: null, periodsPosted: 0, status: 'PendingApproval', requestedBy: user.username, createdBy: user.username,
    }).returning({ id: icLoans.id });
    return this.getLoan(Number(row!.id));
  }

  // Checker: approve a PendingApproval loan (approver ≠ requester ⇒ SOD_SELF_APPROVAL) → post the mirrored
  // drawdown: creditor Dr 1155 / Cr 1010; debtor Dr 1010 / Cr 2155.
  async approveLoan(id: number, user: JwtUser) {
    const db = this.db;
    const loan = await this.loadLoan(id);
    if (loan.status !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Loan is ${loan.status}, not pending approval`, messageTh: 'เงินกู้ไม่ได้อยู่ในสถานะรออนุมัติ' });
    if (loan.requestedBy && loan.requestedBy === user.username) {
      throw new ForbiddenException({ code: 'SOD_SELF_APPROVAL', message: 'Maker-checker: you cannot approve an intercompany loan you registered', messageTh: 'ผู้ลงทะเบียนอนุมัติเงินกู้ระหว่างบริษัทของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    }
    const principal = n(loan.principal);
    const startDate = String(loan.startDate ?? ymd());
    const receivable = postingDefault('ICLOAN.DRAWDOWN', 'ic_loan_receivable'); // 1155
    const payable = postingDefault('ICLOAN.DRAWDOWN', 'ic_loan_payable');       // 2155
    const bank = postingDefault('ICLOAN.DRAWDOWN', 'bank');                     // 1010
    let creditorEntryNo: string | null = null;
    let debtorEntryNo: string | null = null;
    if (this.ledger) {
      // creditor: Dr 1155 IC-loan receivable / Cr 1010 Bank
      const cj: any = await this.ledger.postEntry({
        date: startDate, source: 'ICLOAN-DRAW', sourceRef: loan.loanNo, tenantId: Number(loan.creditorTenantId), currency: loan.currency ?? 'THB',
        memo: `IC loan ${loan.loanNo} drawdown — receivable (creditor)`, createdBy: user.username,
        lines: [{ account_code: receivable, debit: principal }, { account_code: bank, credit: principal }],
      });
      creditorEntryNo = cj?.entry_no ?? null;
      // debtor: Dr 1010 Bank / Cr 2155 IC-loan payable
      const dj: any = await this.ledger.postEntry({
        date: startDate, source: 'ICLOAN-DRAW', sourceRef: `${loan.loanNo}:D`, tenantId: Number(loan.debtorTenantId), currency: loan.currency ?? 'THB',
        memo: `IC loan ${loan.loanNo} drawdown — payable (debtor)`, createdBy: user.username,
        lines: [{ account_code: bank, debit: principal }, { account_code: payable, credit: principal }],
      });
      debtorEntryNo = dj?.entry_no ?? null;
    }
    // First accrual is bookable for the drawdown period (nextRunDate = startDate) so the loan's opening principal
    // and its opening-period interest both land — and both ELIMINATE — in the same consolidation period.
    await db.update(icLoans).set({
      status: 'Approved', approvedBy: user.username, approvedAt: new Date(), carrying: String(principal),
      nextRunDate: startDate, periodsPosted: 0, creditorEntryNo, debtorEntryNo,
    }).where(eq(icLoans.id, id));
    return this.getLoan(id);
  }

  async rejectLoan(id: number, user: JwtUser) {
    const db = this.db;
    const loan = await this.loadLoan(id);
    if (loan.status !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Loan is ${loan.status}, not pending approval`, messageTh: 'เงินกู้ไม่ได้อยู่ในสถานะรออนุมัติ' });
    await db.update(icLoans).set({ status: 'Rejected', approvedBy: user.username, approvedAt: new Date() }).where(eq(icLoans.id, id));
    return this.getLoan(id);
  }

  // ── Idempotent EIR interest accrual — mirrored both sides (TRE-05) ───────────────────────────────────────
  // One month of effective interest = round2(carrying × EIR/100/12) → creditor Dr 1155 / Cr 4700 Investment/
  // Interest Income; debtor Dr 5900 Interest Expense / Cr 2155. Idempotent: the cursor moves a month per run AND
  // alreadyPosted guards the per-period JE, so a re-run of the same as-of posts nothing.
  async accrue(id: number, user: JwtUser, asOf?: string) {
    const db = this.db;
    const loan = await this.loadLoan(id);
    if (loan.status !== 'Approved') throw new BadRequestException({ code: 'LOAN_NOT_APPROVED', message: 'Loan must be approved before accrual', messageTh: 'ต้องอนุมัติเงินกู้ก่อนตั้งดอกเบี้ย' });
    const today = asOf ?? ymd();
    const runDate = loan.nextRunDate ? String(loan.nextRunDate) : null;
    if (!runDate || runDate > today) {
      return { loan_no: loan.loanNo, as_of: today, posted: 0, interest: 0, next_run_date: runDate };
    }
    const carrying = n(loan.carrying);
    const interest = round2(carrying * n(loan.eirPct) / 100 / 12);
    const period = runDate.slice(0, 7);
    const creditorRef = `${loan.loanNo}-${period}`;
    const debtorRef = `${loan.loanNo}-${period}:D`;
    const creditorTid = Number(loan.creditorTenantId);
    const debtorTid = Number(loan.debtorTenantId);
    // Idempotency: if the creditor leg for this period already posted, just advance the cursor.
    if (this.ledger && await this.ledger.alreadyPosted('ICLOAN-ACCR', creditorRef, creditorTid)) {
      await db.update(icLoans).set({ nextRunDate: addMonth(runDate) }).where(eq(icLoans.id, id));
      return { loan_no: loan.loanNo, as_of: today, posted: 0, interest: 0, period, idempotent: true, next_run_date: addMonth(runDate) };
    }
    const receivable = postingDefault('ICLOAN.INTEREST', 'ic_loan_receivable'); // 1155
    const incomeAcct = postingDefault('ICLOAN.INTEREST', 'interest_income');    // 4700
    const expenseAcct = postingDefault('ICLOAN.INTEREST', 'interest_exp');      // 5900
    const payable = postingDefault('ICLOAN.INTEREST', 'ic_loan_payable');       // 2155
    let creditorEntryNo: string | null = null;
    let debtorEntryNo: string | null = null;
    if (this.ledger && interest > 0) {
      // creditor: Dr 1155 / Cr 4700 Investment/Interest Income
      const cj: any = await this.ledger.postEntry({
        date: runDate, source: 'ICLOAN-ACCR', sourceRef: creditorRef, tenantId: creditorTid, currency: loan.currency ?? 'THB',
        memo: `IC loan ${loan.loanNo} interest ${period} — income (creditor)`, createdBy: `${user?.username ?? 'system'} (treasury-pool)`,
        lines: [{ account_code: receivable, debit: interest }, { account_code: incomeAcct, credit: interest }],
      });
      creditorEntryNo = cj?.entry_no ?? null;
      // debtor: Dr 5900 Interest Expense / Cr 2155
      const dj: any = await this.ledger.postEntry({
        date: runDate, source: 'ICLOAN-ACCR', sourceRef: debtorRef, tenantId: debtorTid, currency: loan.currency ?? 'THB',
        memo: `IC loan ${loan.loanNo} interest ${period} — expense (debtor)`, createdBy: `${user?.username ?? 'system'} (treasury-pool)`,
        lines: [{ account_code: expenseAcct, debit: interest }, { account_code: payable, credit: interest }],
      });
      debtorEntryNo = dj?.entry_no ?? null;
    }
    await db.insert(icLoanAccruals).values({
      tenantId: creditorTid, loanId: id, asOf: runDate, period, interest: String(interest),
      creditorEntryNo, debtorEntryNo, createdBy: user.username,
    });
    await db.update(icLoans).set({
      carrying: String(round2(carrying + interest)),
      accruedInterest: String(round2(n(loan.accruedInterest) + interest)),
      periodsPosted: Number(loan.periodsPosted) + 1,
      nextRunDate: addMonth(runDate),
    }).where(eq(icLoans.id, id));
    return {
      loan_no: loan.loanNo, as_of: today, posted: 1, period, interest,
      creditor_entry_no: creditorEntryNo, debtor_entry_no: debtorEntryNo, next_run_date: addMonth(runDate),
    };
  }

  async listLoans(tenantId?: number | null) {
    const db = this.db;
    const tid = this.tenant(tenantId);
    const rows = await db.select().from(icLoans).where(tid != null ? eq(icLoans.tenantId, tid) : undefined).orderBy(desc(icLoans.id));
    return { ic_loans: rows.map(shapeLoan), count: rows.length };
  }

  async getLoan(id: number) {
    const loan = await this.loadLoan(id);
    const db = this.db;
    const accruals = await db.select().from(icLoanAccruals).where(eq(icLoanAccruals.loanId, id)).orderBy(icLoanAccruals.id);
    return { ...shapeLoan(loan), accruals: accruals.map((a: any) => ({ id: Number(a.id), as_of: a.asOf, period: a.period, interest: n(a.interest), creditor_entry_no: a.creditorEntryNo, debtor_entry_no: a.debtorEntryNo })) };
  }

  private async loadPool(id: number) {
    const db = this.db;
    const [p] = await db.select().from(cashPools).where(eq(cashPools.id, id)).limit(1);
    if (!p) throw new NotFoundException({ code: 'POOL_NOT_FOUND', message: `Cash pool ${id} not found`, messageTh: `ไม่พบกลุ่มเงินสด ${id}` });
    return p;
  }

  private async loadLoan(id: number) {
    const db = this.db;
    const [l] = await db.select().from(icLoans).where(eq(icLoans.id, id)).limit(1);
    if (!l) throw new NotFoundException({ code: 'LOAN_NOT_FOUND', message: `Intercompany loan ${id} not found`, messageTh: `ไม่พบเงินกู้ระหว่างบริษัท ${id}` });
    return l;
  }
}

function shapePool(p: any) {
  return { id: Number(p.id), pool_no: p.poolNo, name: p.name, pool_type: p.poolType, header_account: p.headerAccount, currency: p.currency, status: p.status, created_by: p.createdBy };
}
function shapeMember(m: any) {
  return { id: Number(m.id), member_account: m.memberAccount, member_tenant_id: m.memberTenantId ? Number(m.memberTenantId) : null, cap: n(m.cap) };
}
function shapeLoan(l: any) {
  return {
    id: Number(l.id), loan_no: l.loanNo, creditor_tenant_id: Number(l.creditorTenantId), debtor_tenant_id: Number(l.debtorTenantId),
    principal: n(l.principal), eir_pct: n(l.eirPct), carrying: n(l.carrying), accrued_interest: n(l.accruedInterest), currency: l.currency,
    start_date: l.startDate, next_run_date: l.nextRunDate, periods_posted: Number(l.periodsPosted), status: l.status,
    creditor_entry_no: l.creditorEntryNo, debtor_entry_no: l.debtorEntryNo, requested_by: l.requestedBy, approved_by: l.approvedBy, created_by: l.createdBy,
  };
}
