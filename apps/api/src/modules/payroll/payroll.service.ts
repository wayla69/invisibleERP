import { Inject, Injectable, Optional, BadRequestException, type OnModuleInit } from '@nestjs/common';
import { eq, and, desc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { employees, payruns, payslips, timesheets, leaveRequests } from '../../database/schema';
import { journalEntries, journalLines } from '../../database/schema/ledger';
import { LedgerService } from '../ledger/ledger.service';
import { JobWorkerService } from '../jobs/job-worker.service';
import { ymd, n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { computePayslipFull, overtimePay } from './payroll-calc';

const r2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

// Job type for an async payroll run (off the request thread via the background-job queue).
export const PAYROLL_RUN_JOB = 'payroll_run';

export interface EmployeeDto {
  emp_code?: string; name: string; national_id?: string; sso_no?: string; position?: string; department?: string;
  monthly_salary: number; hourly_rate?: number; pf_rate?: number; allowances?: number; sso_eligible?: boolean; bank_account?: string; start_date?: string;
}

@Injectable()
export class PayrollService implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly ledger: LedgerService,
    // @Optional so partial harnesses that construct PayrollService without the (global) JobsModule still work.
    @Optional() private readonly worker?: JobWorkerService,
  ) {}

  // Register the worker handler for an async payroll run. The worker has already established the job's tenant
  // transaction (runInTenantContext), so runPayroll's DRIZZLE queries are RLS-scoped exactly as in a request.
  // runPayroll is idempotent per (tenant, period) → safe under the queue's at-least-once retry semantics.
  onModuleInit(): void {
    this.worker?.register(PAYROLL_RUN_JOB, async (payload: any, ctx) => {
      const user: JwtUser = { username: ctx.actor ?? 'system:payroll', role: ctx.bypass ? 'Admin' : 'Sales', customerName: null, tenantId: ctx.tenantId, permissions: [] };
      return this.runPayroll(String(payload.period), user, ctx.tenantId);
    });
  }

  // ── Employees (tenant-scoped via RLS) ──
  async createEmployee(dto: EmployeeDto, user: JwtUser) {
    const db = this.db as any;
    const code = (dto.emp_code?.trim()) || `EMP${String(Date.now()).slice(-6)}`;
    const [row] = await db.insert(employees).values({
      tenantId: user.tenantId ?? null, empCode: code, name: dto.name, nationalId: dto.national_id ?? null,
      ssoNo: dto.sso_no ?? null, position: dto.position ?? null, department: dto.department ?? null, monthlySalary: fx(dto.monthly_salary ?? 0, 2),
      hourlyRate: fx(dto.hourly_rate ?? 0, 2), pfRate: fx(dto.pf_rate ?? 0, 4),
      allowances: fx(dto.allowances ?? 0, 2), ssoEligible: dto.sso_eligible ?? true,
      bankAccount: dto.bank_account ?? null, startDate: dto.start_date ?? null, active: true,
    }).returning();
    return this.fmtEmp(row);
  }

  async listEmployees(user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(employees).where(eq(employees.active, true)).orderBy(employees.empCode);
    return { employees: rows.map((r: any) => this.fmtEmp(r)), count: rows.length };
  }

  // ── Run payroll for a period → balanced GL entry + payslips. Idempotent per (tenant, period). ──
  async runPayroll(period: string, user: JwtUser, explicitTenantId?: number | null) {
    if (!/^\d{4}-\d{2}$/.test(period)) throw new BadRequestException({ code: 'BAD_PERIOD', message: 'period must be YYYY-MM', messageTh: 'งวดต้องเป็น YYYY-MM' });
    const db = this.db as any;
    // Resolve the tenant to run for. A scoped (non-HQ) user always runs for their own tenant; an HQ/Admin
    // caller (tenantId null, RLS-bypass) MUST name a tenant_id — otherwise the employee query below spans
    // EVERY tenant and posts one cross-tenant JE under tenant_id null (escaping RLS + the close calendar).
    const tenantId = user.tenantId ?? (explicitTenantId != null ? Number(explicitTenantId) : null);
    if (tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'HQ/Admin must specify tenant_id to run payroll', messageTh: 'สำนักงานใหญ่ต้องระบุ tenant_id เพื่อรันเงินเดือน' });
    // Idempotency on the run record, not the JE: a run that is PendingApproval or Posted blocks a re-run;
    // a Rejected run may be re-run (it produces a fresh Draft for re-approval — the old JE stays Voided).
    const [existingRun] = await db.select().from(payruns)
      .where(and(eq(payruns.period, period), eq(payruns.tenantId, tenantId), sql`${payruns.status} in ('PendingApproval','Posted')`))
      .orderBy(desc(payruns.id)).limit(1);
    if (existingRun) return { already: true, period, status: existingRun.status, entry_no: existingRun.entryNo };

    // Explicit tenant filter so the run is correct even for an Admin caller whose request bypasses RLS.
    const emps = await db.select().from(employees).where(and(eq(employees.active, true), eq(employees.tenantId, tenantId)));
    if (!emps.length) throw new BadRequestException({ code: 'NO_EMPLOYEES', message: 'No active employees to pay', messageTh: 'ไม่มีพนักงานที่ใช้งานอยู่' });

    const like = `${period}%`;
    const slips: any[] = [];
    for (const e of emps) {
      // overtime hours from attendance + unpaid-leave days from approved requests, for this period
      const [otRow] = await db.select({ h: sql<string>`coalesce(sum(${timesheets.otHours}),0)` }).from(timesheets)
        .where(and(eq(timesheets.employeeId, Number(e.id)), sql`${timesheets.workDate}::text like ${like}`));
      const [lvRow] = await db.select({ d: sql<string>`coalesce(sum(${leaveRequests.days}),0)` }).from(leaveRequests)
        .where(and(eq(leaveRequests.employeeId, Number(e.id)), eq(leaveRequests.paid, false), sql`${leaveRequests.status}::text = 'Approved'`, sql`${leaveRequests.fromDate}::text like ${like}`));
      const otPay = overtimePay(n(otRow?.h), n(e.hourlyRate));
      const unpaidAmount = r2(n(lvRow?.d) * (n(e.monthlySalary) / 30));
      const c = computePayslipFull({ monthlySalary: n(e.monthlySalary), otPay, unpaidAmount, ssoEligible: e.ssoEligible !== false, pfRate: n(e.pfRate), allowances: n(e.allowances) });
      slips.push({ e, ...c });
    }
    const sum = (k: string) => r2(slips.reduce((a: number, s: any) => a + Number(s[k]), 0));
    const grossTotal = sum('gross'), ssoEe = sum('sso_employee'), ssoEr = sum('sso_employer'), whtTotal = sum('wht'), netTotal = sum('net');
    const pfEe = sum('pf_employee'), pfEr = sum('pf_employer'), otTotal = sum('ot_pay'), unpaidTotal = sum('unpaid');

    // GL: Dr 5600 salaries + 5610 employer-SSO (+ 5620 employer-PF) / Cr 1000 net + 2350 SSO-payable
    // + 2360 WHT-payable (+ 2370 PF-payable). Balanced: Dr (gross+erSSO+erPF) == Cr (net+ssoBoth+wht+pfBoth).
    const lines: { account_code: string; debit?: number; credit?: number; memo?: string }[] = [
      { account_code: '5600', debit: grossTotal, memo: 'Salaries + OT − unpaid' },
      { account_code: '5610', debit: ssoEr, memo: 'Employer social security' },
      { account_code: '1000', credit: netTotal, memo: 'Net pay' },
      { account_code: '2350', credit: r2(ssoEe + ssoEr), memo: 'Social security payable' },
      { account_code: '2360', credit: whtTotal, memo: 'Payroll WHT payable (PND1)' },
    ];
    if (pfEr > 0 || pfEe > 0) {
      lines.push({ account_code: '5620', debit: pfEr, memo: 'Employer provident fund' });
      lines.push({ account_code: '2370', credit: r2(pfEe + pfEr), memo: 'Provident fund payable' });
    }
    // PAY-03: post the JE as a DRAFT (excluded from balances) — a DIFFERENT user must approve it (below)
    // before it becomes effective. The run record mirrors this with status 'PendingApproval'.
    const je: any = await this.ledger.postEntry({
      date: `${period}-28`, source: 'PAYROLL', sourceRef: period, tenantId,
      memo: `Payroll ${period} (${slips.length} staff)`, createdBy: user.username, lines,
      pendingApproval: true,
    });

    const [run] = await db.insert(payruns).values({
      tenantId, period, status: 'PendingApproval', headcount: slips.length,
      grossTotal: fx(grossTotal, 2), ssoEeTotal: fx(ssoEe, 2), ssoErTotal: fx(ssoEr, 2),
      whtTotal: fx(whtTotal, 2), netTotal: fx(netTotal, 2), entryNo: je.entry_no, runBy: user.username,
    }).returning({ id: payruns.id });

    await db.insert(payslips).values(slips.map((s: any) => ({
      payrunId: Number(run.id), tenantId, employeeId: Number(s.e.id), empCode: s.e.empCode, empName: s.e.name, nationalId: s.e.nationalId,
      gross: fx(s.gross, 2), otPay: fx(s.ot_pay, 2), unpaid: fx(s.unpaid, 2), ssoEmployee: fx(s.sso_employee, 2), ssoEmployer: fx(s.sso_employer, 2),
      pfEmployee: fx(s.pf_employee, 2), pfEmployer: fx(s.pf_employer, 2), wht: fx(s.wht, 2), net: fx(s.net, 2),
    })));

    return {
      period, entry_no: je.entry_no, status: 'PendingApproval', headcount: slips.length,
      gross_total: grossTotal, ot_total: otTotal, unpaid_total: unpaidTotal,
      sso_employee_total: ssoEe, sso_employer_total: ssoEr, pf_employee_total: pfEe, pf_employer_total: pfEr,
      wht_total: whtTotal, net_total: netTotal,
    };
  }

  // ── PAY-03 maker-checker: a DIFFERENT user approves the pending run → the Draft JE becomes effective. ──
  // Reuses the GL-05 ledger approval, which enforces approver ≠ preparer (SoD) and re-checks the period is
  // open at approval time. Payroll is a top fraud-risk cycle, so the run-er can never post their own pay.
  async approvePayroll(period: string, user: JwtUser, explicitTenantId?: number | null) {
    const db = this.db as any;
    const run = await this.pendingRun(period, user, explicitTenantId);
    const res: any = await this.ledger.approveEntry(run.entryNo, user);
    await db.update(payruns).set({ status: 'Posted', approvedBy: user.username, approvedAt: new Date() }).where(eq(payruns.id, Number(run.id)));
    return { period, entry_no: run.entryNo, status: 'Posted', approved_by: user.username, prepared_by: res.prepared_by ?? run.runBy };
  }

  // Reject a pending run → voids the Draft JE and marks the run Rejected (a fresh run may then be made).
  async rejectPayroll(period: string, user: JwtUser, reason?: string, explicitTenantId?: number | null) {
    const db = this.db as any;
    const run = await this.pendingRun(period, user, explicitTenantId);
    await this.ledger.rejectEntry(run.entryNo, user, reason);
    await db.update(payruns).set({ status: 'Rejected' }).where(eq(payruns.id, Number(run.id)));
    return { period, entry_no: run.entryNo, status: 'Rejected', rejected_by: user.username };
  }

  // Resolve the single PendingApproval run for (tenant, period) or raise a clean 4xx.
  private async pendingRun(period: string, user: JwtUser, explicitTenantId?: number | null) {
    const db = this.db as any;
    const tenantId = user.tenantId ?? (explicitTenantId != null ? Number(explicitTenantId) : null);
    if (tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'HQ/Admin must specify tenant_id', messageTh: 'สำนักงานใหญ่ต้องระบุ tenant_id' });
    const [run] = await db.select().from(payruns).where(and(eq(payruns.period, period), eq(payruns.tenantId, tenantId), eq(payruns.status, 'PendingApproval'))).orderBy(desc(payruns.id)).limit(1);
    if (!run) throw new BadRequestException({ code: 'NO_PENDING_PAYROLL', message: `No payroll run pending approval for ${period}`, messageTh: 'ไม่มีรอบเงินเดือนที่รออนุมัติสำหรับงวดนี้' });
    return run;
  }

  // ภ.ง.ด.1ก — annual withholding summary per employee (income + WHT for the year).
  async pnd1a(year: string, user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select({
      empName: payslips.empName, nationalId: payslips.nationalId,
      income: sql<string>`coalesce(sum(${payslips.gross}),0)`, wht: sql<string>`coalesce(sum(${payslips.wht}),0)`,
    }).from(payslips).innerJoin(payruns, eq(payslips.payrunId, payruns.id))
      .where(sql`${payruns.period}::text like ${year + '-%'}`).groupBy(payslips.empName, payslips.nationalId);
    const lines = rows.map((r: any) => ({ emp_name: r.empName, national_id: r.nationalId, income: n(r.income), wht: n(r.wht) }));
    return {
      year, form: 'PND1A', headcount: lines.length, lines,
      total_income: r2(lines.reduce((a: number, l: any) => a + l.income, 0)),
      total_wht: r2(lines.reduce((a: number, l: any) => a + l.wht, 0)),
      deadline: 'ยื่นแบบ ภ.ง.ด.1ก ภายในเดือนกุมภาพันธ์ของปีถัดไป',
    };
  }

  // ── Payroll-liability reconciliation & remittance (PAY-02) ──
  // The statutory withholdings posted by a payrun (SSO 2350, WHT/PND1 2360, PF 2370) are LIABILITIES owed to
  // outside authorities. This schedule ties each account's GL net balance (accrued − remitted = outstanding)
  // back to the independent payrun accrual, and lets treasury REMIT the cash so the liability is cleared and
  // the books reconcile to the statutory filings.
  private readonly LIAB = [
    { code: '2350', label: 'ประกันสังคม (SSO)', authority: 'สำนักงานประกันสังคม', deadline: 'นำส่งภายในวันที่ 15 ของเดือนถัดไป' },
    { code: '2360', label: 'ภาษีหัก ณ ที่จ่าย (ภ.ง.ด.1)', authority: 'กรมสรรพากร', deadline: 'นำส่ง ภ.ง.ด.1 ภายในวันที่ 7 ของเดือนถัดไป' },
    { code: '2370', label: 'กองทุนสำรองเลี้ยงชีพ (PF)', authority: 'บริษัทจัดการกองทุน', deadline: 'นำส่งภายใน 3 วันทำการ' },
  ];

  private liabTenant(user: JwtUser, explicitTenantId?: number | null) {
    const tenantId = user.tenantId ?? (explicitTenantId != null ? Number(explicitTenantId) : null);
    if (tenantId == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'HQ/Admin must specify tenant_id', messageTh: 'สำนักงานใหญ่ต้องระบุ tenant_id' });
    return tenantId;
  }

  // GL debit/credit totals for one account (Posted entries only — Draft JEs are excluded from balances).
  private async glAcct(accountCode: string, tenantId: number) {
    const db = this.db as any;
    const [r] = await db.select({
      debit: sql<string>`coalesce(sum(${journalLines.debit}),0)`,
      credit: sql<string>`coalesce(sum(${journalLines.credit}),0)`,
    }).from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(eq(journalEntries.tenantId, tenantId), eq(journalEntries.status, 'Posted'), eq(journalLines.accountCode, accountCode)));
    return { debit: n(r?.debit ?? 0), credit: n(r?.credit ?? 0) };
  }

  async liabilities(user: JwtUser, explicitTenantId?: number | null) {
    const tenantId = this.liabTenant(user, explicitTenantId);
    const db = this.db as any;
    // Independent expected accrual from the payrun aggregates (NOT the GL) for SSO + WHT — a divergence from the
    // GL credits means a manual JE touched a payroll-liability account outside the payroll process.
    const [pr] = await db.select({
      sso: sql<string>`coalesce(sum(${payruns.ssoEeTotal} + ${payruns.ssoErTotal}),0)`,
      wht: sql<string>`coalesce(sum(${payruns.whtTotal}),0)`,
    }).from(payruns).where(and(eq(payruns.tenantId, tenantId), eq(payruns.status, 'Posted')));
    const expected: Record<string, number | null> = { '2350': r2(n(pr?.sso ?? 0)), '2360': r2(n(pr?.wht ?? 0)), '2370': null };
    const lines = [] as any[];
    for (const L of this.LIAB) {
      const g = await this.glAcct(L.code, tenantId);
      const accrued = r2(g.credit), remitted = r2(g.debit), outstanding = r2(g.credit - g.debit);
      const exp = expected[L.code];
      lines.push({ account_code: L.code, label: L.label, authority: L.authority, deadline: L.deadline, accrued, remitted, outstanding, expected_accrued: exp, reconciled: exp == null ? true : Math.abs(accrued - exp) < 0.01 });
    }
    return { lines, total_outstanding: r2(lines.reduce((a, l) => a + l.outstanding, 0)), all_reconciled: lines.every((l) => l.reconciled) };
  }

  async remitLiability(dto: { account_code: string; amount: number; ref?: string }, user: JwtUser, explicitTenantId?: number | null) {
    const tenantId = this.liabTenant(user, explicitTenantId);
    const L = this.LIAB.find((x) => x.code === dto.account_code);
    if (!L) throw new BadRequestException({ code: 'NOT_LIABILITY_ACCOUNT', message: `${dto.account_code} is not a payroll-liability account (2350/2360/2370)`, messageTh: 'ไม่ใช่บัญชีหนี้สินเงินเดือน (2350/2360/2370)' });
    const amount = r2(dto.amount);
    if (!(amount > 0)) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'Amount must be positive', messageTh: 'จำนวนเงินต้องมากกว่า 0' });
    const g = await this.glAcct(dto.account_code, tenantId);
    const outstanding = r2(g.credit - g.debit);
    if (amount > outstanding + 0.01) throw new BadRequestException({ code: 'REMIT_EXCEEDS_OUTSTANDING', message: `Remittance ${amount} exceeds outstanding ${outstanding}`, messageTh: `ยอดนำส่งเกินยอดค้างชำระ (คงเหลือ ${outstanding})` });
    const je: any = await this.ledger.postEntry({
      source: 'PAY-REMIT', sourceRef: `${dto.account_code}:${dto.ref ?? new Date().toISOString()}`, tenantId,
      memo: `นำส่ง ${L.label} → ${L.authority}`, createdBy: user.username,
      lines: [
        { account_code: dto.account_code, debit: amount, memo: `Remit ${L.label}` },
        { account_code: '1000', credit: amount, memo: `Cash paid to ${L.authority}` },
      ],
    });
    return { account_code: dto.account_code, label: L.label, remitted: amount, outstanding_after: r2(outstanding - amount), entry_no: je.entry_no };
  }

  async listRuns(user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(payruns).orderBy(desc(payruns.period), desc(payruns.id)).limit(36);
    return { runs: rows.map((r: any) => ({ period: r.period, status: r.status, headcount: Number(r.headcount), gross_total: n(r.grossTotal), sso_employee_total: n(r.ssoEeTotal), sso_employer_total: n(r.ssoErTotal), wht_total: n(r.whtTotal), net_total: n(r.netTotal), entry_no: r.entryNo, run_by: r.runBy, approved_by: r.approvedBy, run_at: r.runAt, approved_at: r.approvedAt })), count: rows.length };
  }

  async getSlips(period: string, user: JwtUser) {
    const db = this.db as any;
    const [run] = await db.select().from(payruns).where(eq(payruns.period, period)).orderBy(desc(payruns.id)).limit(1);
    if (!run) return { period, slips: [], count: 0 };
    const rows = await db.select().from(payslips).where(eq(payslips.payrunId, Number(run.id))).orderBy(payslips.empCode);
    return { period, entry_no: run.entryNo, slips: rows.map((s: any) => ({ emp_code: s.empCode, emp_name: s.empName, national_id: s.nationalId, gross: n(s.gross), sso_employee: n(s.ssoEmployee), sso_employer: n(s.ssoEmployer), wht: n(s.wht), net: n(s.net) })), count: rows.length };
  }

  // ภ.ง.ด.1 — monthly salary WHT remittance: per-employee withheld + total payable to the Revenue Dept.
  async pnd1(period: string, user: JwtUser) {
    const db = this.db as any;
    const [run] = await db.select().from(payruns).where(eq(payruns.period, period)).orderBy(desc(payruns.id)).limit(1);
    if (!run) return { period, form: 'PND1', lines: [], total_income: 0, total_wht: 0, headcount: 0, deadline: `ยื่นแบบ ภ.ง.ด.1 ภายในวันที่ 7 ของเดือนถัดไป` };
    const rows = await db.select().from(payslips).where(eq(payslips.payrunId, Number(run.id)));
    const lines = rows.map((s: any) => ({ emp_name: s.empName, national_id: s.nationalId, income: n(s.gross), wht: n(s.wht) }));
    return {
      period, form: 'PND1',
      lines, headcount: lines.length,
      total_income: r2(lines.reduce((a: number, l: any) => a + l.income, 0)),
      total_wht: r2(lines.reduce((a: number, l: any) => a + l.wht, 0)),
      deadline: `ยื่นแบบ ภ.ง.ด.1 ภายในวันที่ 7 ของเดือนถัดไป`,
    };
  }

  private fmtEmp(r: any) {
    return { id: Number(r.id), emp_code: r.empCode, name: r.name, national_id: r.nationalId, sso_no: r.ssoNo, position: r.position, monthly_salary: n(r.monthlySalary), allowances: n(r.allowances), sso_eligible: r.ssoEligible !== false, bank_account: r.bankAccount, start_date: r.startDate, active: r.active !== false };
  }
}
