import { Inject, Injectable, Optional, BadRequestException, ForbiddenException, NotFoundException, ConflictException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { employees, payslips } from '../../database/schema/payroll';
import { timesheets, leaveRequests, leaveBalances, expenseClaims } from '../../database/schema/hcm';
import { FinanceService } from '../finance/finance.service';
import { n, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { LineNotifyService } from '../messaging/line-notify.service';

export interface LeaveSelfDto { leave_type?: string; from_date: string; to_date: string; days: number; paid?: boolean; reason?: string }
export interface ExpenseDto { claim_date?: string; category?: string; amount: number; description?: string }

// Phase D3 — Employee Self-Service. Every method resolves the employee from the JWT username (NEVER a
// body param) and scopes strictly to that employee's own rows — an employee can only see/act on their
// own timesheets/leave/payslips/expenses. Tenant isolation is enforced by RLS on top.
@Injectable()
export class EssService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly finance: FinanceService,
    // LC-3 (docs/30) — LINE notify: leave-approvers (holders of the /api/hcm gate perms) hear about a
    // new self-service leave request; the maker is excluded. Best-effort — never blocks the request.
    @Optional() private readonly lineNotify?: LineNotifyService,
  ) {}

  // Resolve the logged-in user → their employee row (by user_name link, emp_code fallback). RLS scopes
  // to the caller's tenant, so this can only ever find an employee in their own tenant.
  private async me(user: JwtUser): Promise<any> {
    const db = this.db;
    let [emp] = await db.select().from(employees).where(eq(employees.userName, user.username)).limit(1);
    if (!emp) [emp] = await db.select().from(employees).where(eq(employees.empCode, user.username)).limit(1);
    if (!emp) throw new ForbiddenException({ code: 'ESS_NO_EMPLOYEE', message: 'No employee record linked to this user', messageTh: 'บัญชีนี้ยังไม่ผูกกับพนักงาน' });
    return emp;
  }

  async profile(user: JwtUser) {
    const db = this.db;
    const emp = await this.me(user);
    const balances = await db.select().from(leaveBalances).where(eq(leaveBalances.employeeId, Number(emp.id)));
    return { employee: { id: Number(emp.id), emp_code: emp.empCode, name: emp.name, position: emp.position, department: emp.department }, leave_balances: balances.map((b: any) => ({ leave_type: b.leaveType, year: n(b.year), entitled: n(b.entitled), used: n(b.used), remaining: n(b.entitled) - n(b.used) })) };
  }

  async myTimesheets(user: JwtUser) {
    const db = this.db;
    const emp = await this.me(user);
    const rows = await db.select().from(timesheets).where(eq(timesheets.employeeId, Number(emp.id))).orderBy(desc(timesheets.id)).limit(200);
    return { timesheets: rows, count: rows.length };
  }

  async myLeave(user: JwtUser) {
    const db = this.db;
    const emp = await this.me(user);
    const rows = await db.select().from(leaveRequests).where(eq(leaveRequests.employeeId, Number(emp.id))).orderBy(desc(leaveRequests.id));
    return { leave_requests: rows, count: rows.length };
  }

  async requestLeave(dto: LeaveSelfDto, user: JwtUser) {
    if (!dto.from_date || !dto.to_date || !(n(dto.days) > 0)) throw new BadRequestException({ code: 'BAD_PAYLOAD', message: 'from_date, to_date, days required', messageTh: 'ต้องระบุวันที่และจำนวนวัน' });
    const db = this.db;
    const emp = await this.me(user);
    const [r] = await db.insert(leaveRequests).values({ tenantId: emp.tenantId, employeeId: Number(emp.id), leaveType: dto.leave_type ?? 'annual', fromDate: dto.from_date, toDate: dto.to_date, days: String(n(dto.days)), paid: dto.paid ?? true, status: 'Pending', reason: dto.reason ?? null, createdBy: user.username }).returning({ id: leaveRequests.id });
    await this.lineNotify?.notifyPermissionHolders(['exec', 'users', 'creditors'], emp.tenantId ?? user.tenantId ?? null,
      `🔔 ใบลารออนุมัติ: ${emp.name ?? emp.empCode} ลา ${n(dto.days)} วัน (${dto.from_date} → ${dto.to_date})${dto.reason ? ` — ${dto.reason}` : ''}\nอนุมัติที่หน้า /hcm`,
      user.username);
    return { id: Number(r!.id), status: 'Pending', emp_code: emp.empCode, days: n(dto.days) };
  }

  async myPayslips(user: JwtUser) {
    const db = this.db;
    const emp = await this.me(user);
    const rows = await db.select().from(payslips).where(eq(payslips.employeeId, Number(emp.id))).orderBy(desc(payslips.id)).limit(36);
    return { payslips: rows.map((p: any) => ({ id: Number(p.id), emp_code: p.empCode, gross: n(p.gross), ot_pay: n(p.otPay), sso_employee: n(p.ssoEmployee), pf_employee: n(p.pfEmployee), wht: n(p.wht), net: n(p.net) })), count: rows.length };
  }

  async myExpenses(user: JwtUser) {
    const db = this.db;
    const emp = await this.me(user);
    const rows = await db.select().from(expenseClaims).where(eq(expenseClaims.employeeId, Number(emp.id))).orderBy(desc(expenseClaims.id));
    return { expense_claims: rows, count: rows.length };
  }

  async submitExpense(dto: ExpenseDto, user: JwtUser) {
    if (!(n(dto.amount) > 0)) throw new BadRequestException({ code: 'BAD_PAYLOAD', message: 'amount must be > 0', messageTh: 'จำนวนเงินต้องมากกว่า 0' });
    const db = this.db;
    const emp = await this.me(user);
    const [r] = await db.insert(expenseClaims).values({ tenantId: emp.tenantId, employeeId: Number(emp.id), claimDate: dto.claim_date ?? ymd(), category: dto.category ?? 'general', amount: String(n(dto.amount)), description: dto.description ?? null, status: 'Pending', createdBy: user.username }).returning({ id: expenseClaims.id });
    return { id: Number(r!.id), status: 'Pending', amount: n(dto.amount) };
  }

  // Approver inbox — every PENDING expense claim awaiting a decision, with the claimant's name/code so a
  // manager can act on it (perm 'approvals', gated at the controller). Tenant-scoped by RLS; self-scoping
  // does NOT apply here (an approver sees other employees' claims). The decide call still blocks
  // self-approval (SoD), so a claim the approver raised themselves can be listed but not approved by them.
  async listPendingExpenses() {
    const db = this.db;
    const rows = await db
      .select({
        id: expenseClaims.id, claim_date: expenseClaims.claimDate, category: expenseClaims.category,
        amount: expenseClaims.amount, description: expenseClaims.description, status: expenseClaims.status,
        emp_code: employees.empCode, employee_name: employees.name,
      })
      .from(expenseClaims)
      .leftJoin(employees, eq(expenseClaims.employeeId, employees.id))
      .where(eq(expenseClaims.status, 'Pending'))
      .orderBy(desc(expenseClaims.id));
    return { pending: rows.map((r: any) => ({ ...r, amount: n(r.amount) })), count: rows.length };
  }

  // Manager approval (perm 'approvals'/'exec', gated at the controller). SoD: the approver must not be
  // the claimant. On approval, raise an **AP reimbursement payable** to the employee — this posts the GL
  // (Dr 5100 Operating Expense / Cr 2000 AP) AND creates the AP sub-ledger row, so the reimbursement shows
  // in AP aging, is settled through the normal AP pay flow, and keeps the AP sub-ledger ↔ GL control
  // account (2000) reconciled. Reimbursements carry no claimable input VAT (vat_treatment 'exempt').
  async approveExpense(id: number, approve: boolean, user: JwtUser) {
    const db = this.db;
    const [c] = await db.select().from(expenseClaims).where(eq(expenseClaims.id, id)).limit(1);
    if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Claim not found', messageTh: 'ไม่พบรายการเบิก' });
    if (c.status !== 'Pending') throw new ConflictException({ code: 'NOT_PENDING', message: `Claim is ${c.status}`, messageTh: 'รายการนี้ตัดสินแล้ว' });
    const [emp] = await db.select().from(employees).where(eq(employees.id, Number(c.employeeId))).limit(1);
    // SoD: block self-approval. me() resolves a user to their employee by user_name OR emp_code, so match
    // on BOTH here — otherwise an employee linked only by emp_code (user_name null) could approve their own.
    if (emp && (emp.userName === user.username || emp.empCode === user.username)) throw new BadRequestException({ code: 'SOD_SELF_APPROVAL', message: 'Cannot approve your own expense claim', messageTh: 'อนุมัติรายการเบิกของตนเองไม่ได้' });
    if (!approve) {
      await db.update(expenseClaims).set({ status: 'Rejected', decidedBy: user.username, decidedAt: new Date() }).where(eq(expenseClaims.id, id));
      return { id, status: 'Rejected' };
    }
    const ap = await this.finance.createApTxn({
      vendor_name: `Employee ${emp?.empCode ?? c.employeeId}`, txn_type: 'Reimbursement',
      invoice_no: `EXP-${id}`, invoice_date: c.claimDate ?? ymd(), due_date: c.claimDate ?? ymd(),
      amount: n(c.amount), vat_treatment: 'exempt', expense_account: '5100',
      tenant_id: c.tenantId, idempotency_key: `EXP-${id}`,
      remarks: `Expense reimbursement ${emp?.empCode ?? ''} — ${c.category ?? 'general'}`.trim(),
    }, user);
    await db.update(expenseClaims).set({ status: 'Approved', decidedBy: user.username, decidedAt: new Date(), apTxnNo: ap?.txn_no ?? null }).where(eq(expenseClaims.id, id));
    return { id, status: 'Approved', ap_txn_no: ap?.txn_no ?? null, payable: true };
  }
}
