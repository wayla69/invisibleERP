import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { employees, payruns, payslips } from '../../database/schema';
import { LedgerService } from '../ledger/ledger.service';
import { ymd, n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { computePayslip } from './payroll-calc';

const r2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

export interface EmployeeDto {
  emp_code?: string; name: string; national_id?: string; sso_no?: string; position?: string;
  monthly_salary: number; allowances?: number; sso_eligible?: boolean; bank_account?: string; start_date?: string;
}

@Injectable()
export class PayrollService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly ledger: LedgerService,
  ) {}

  // ── Employees (tenant-scoped via RLS) ──
  async createEmployee(dto: EmployeeDto, user: JwtUser) {
    const db = this.db as any;
    const code = (dto.emp_code?.trim()) || `EMP${String(Date.now()).slice(-6)}`;
    const [row] = await db.insert(employees).values({
      tenantId: user.tenantId ?? null, empCode: code, name: dto.name, nationalId: dto.national_id ?? null,
      ssoNo: dto.sso_no ?? null, position: dto.position ?? null, monthlySalary: fx(dto.monthly_salary ?? 0, 2),
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
  async runPayroll(period: string, user: JwtUser) {
    if (!/^\d{4}-\d{2}$/.test(period)) throw new BadRequestException({ code: 'BAD_PERIOD', message: 'period must be YYYY-MM', messageTh: 'งวดต้องเป็น YYYY-MM' });
    const db = this.db as any;
    const tenantId = user.tenantId ?? null;
    if (await this.ledger.alreadyPosted('PAYROLL', period, tenantId)) {
      const [existing] = await db.select().from(payruns).where(and(eq(payruns.period, period))).orderBy(desc(payruns.id)).limit(1);
      return { already: true, period, entry_no: existing?.entryNo ?? null };
    }

    const emps = await db.select().from(employees).where(eq(employees.active, true));
    if (!emps.length) throw new BadRequestException({ code: 'NO_EMPLOYEES', message: 'No active employees to pay', messageTh: 'ไม่มีพนักงานที่ใช้งานอยู่' });

    const slips = emps.map((e: any) => {
      const c = computePayslip(n(e.monthlySalary), e.ssoEligible !== false, n(e.allowances));
      return { e, ...c };
    });
    const sum = (k: keyof (typeof slips)[number]) => r2(slips.reduce((a: number, s: any) => a + Number(s[k]), 0));
    const grossTotal = sum('gross'), ssoEe = sum('sso_employee'), ssoEr = sum('sso_employer'), whtTotal = sum('wht'), netTotal = sum('net');

    // GL: Dr 5600 salaries + Dr 5610 employer SSO / Cr 1000 cash(net) + Cr 2350 SSO payable(ee+er) + Cr 2360 WHT payable.
    // Balanced by construction: Dr (gross + er) == Cr (net + ee + er + wht), since net = gross - ee - wht.
    const lines = [
      { account_code: '5600', debit: grossTotal, memo: 'Salaries' },
      { account_code: '5610', debit: ssoEr, memo: 'Employer social security' },
      { account_code: '1000', credit: netTotal, memo: 'Net pay' },
      { account_code: '2350', credit: r2(ssoEe + ssoEr), memo: 'Social security payable' },
      { account_code: '2360', credit: whtTotal, memo: 'Payroll WHT payable (PND1)' },
    ];
    const je: any = await this.ledger.postEntry({
      date: `${period}-28`, source: 'PAYROLL', sourceRef: period, tenantId,
      memo: `Payroll ${period} (${slips.length} staff)`, createdBy: user.username, lines,
    });

    const [run] = await db.insert(payruns).values({
      tenantId, period, status: 'Posted', headcount: slips.length,
      grossTotal: fx(grossTotal, 2), ssoEeTotal: fx(ssoEe, 2), ssoErTotal: fx(ssoEr, 2),
      whtTotal: fx(whtTotal, 2), netTotal: fx(netTotal, 2), entryNo: je.entry_no, runBy: user.username,
    }).returning({ id: payruns.id });

    await db.insert(payslips).values(slips.map((s: any) => ({
      payrunId: Number(run.id), tenantId, employeeId: Number(s.e.id), empCode: s.e.empCode, empName: s.e.name, nationalId: s.e.nationalId,
      gross: fx(s.gross, 2), ssoEmployee: fx(s.sso_employee, 2), ssoEmployer: fx(s.sso_employer, 2), wht: fx(s.wht, 2), net: fx(s.net, 2),
    })));

    return {
      period, entry_no: je.entry_no, headcount: slips.length,
      gross_total: grossTotal, sso_employee_total: ssoEe, sso_employer_total: ssoEr, wht_total: whtTotal, net_total: netTotal,
    };
  }

  async listRuns(user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(payruns).orderBy(desc(payruns.period), desc(payruns.id)).limit(36);
    return { runs: rows.map((r: any) => ({ period: r.period, status: r.status, headcount: Number(r.headcount), gross_total: n(r.grossTotal), sso_employee_total: n(r.ssoEeTotal), sso_employer_total: n(r.ssoErTotal), wht_total: n(r.whtTotal), net_total: n(r.netTotal), entry_no: r.entryNo, run_at: r.runAt })), count: rows.length };
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
