import { Inject, Injectable, Optional, BadRequestException, NotFoundException, ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { pettyCashFunds, expenseRequests, projects } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { StatusLogService } from '../../common/status-log.service';
import { LedgerService } from '../ledger/ledger.service';
import { postingDefault } from '../ledger/posting-events';
import { LineNotifyService } from '../messaging/line-notify.service';
import { CommitmentsService } from '../commitments/commitments.service';
import { ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import type { EstablishFundDto, ReplenishDto, ExpenseRequestDto, SettleExpenseDto } from './dto';

const n = (v: unknown) => Number(v ?? 0);
const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

// Petty cash imprest float (วงเงิน) + direct-expense / advance maker-checker with document tracking (EXP-08).
// A fund holds cash capped at a credit limit; requests draw against it and post to the GL only on independent
// approval (requester ≠ approver). The 1015 petty-cash account is a cash account (cash-flow + reconciliation).
@Injectable()
export class PettyCashService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    @Optional() private readonly statusLog?: StatusLogService,
    @Optional() private readonly ledger?: LedgerService,
    // LC-2 (docs/30) — LINE notifications on the EXP-08 maker-checker: approvers (creditors/exec holders,
    // maker excluded) hear about a new request; the requester hears the decision. Best-effort by design.
    @Optional() private readonly lineNotify?: LineNotifyService,
    @Optional() private readonly commitments?: CommitmentsService, // FU1 (docs/32) — site cash consumes BoQ budget
  ) {}

  // ── Fund: establish + replenish. Both move real cash INTO the imprest (Dr 1015 / Cr 1000) — so per the
  //    maker-checker audit (gap G3) that cash-in is now a FUNDING request (EXP-08): it posts to the GL and
  //    lifts the fund balance only when a DIFFERENT user approves it. The fund record itself is created at
  //    establishment (balance 0) so the fund exists while its initial funding awaits approval. ──
  async establishFund(dto: EstablishFundDto, user: JwtUser) {
    const db = this.db;
    const tenantId = user.tenantId ?? null;
    const float = round2(dto.float_limit);
    if (!(float > 0)) throw new BadRequestException({ code: 'BAD_FLOAT', message: 'float_limit must be > 0', messageTh: 'วงเงินต้องมากกว่าศูนย์' });
    const initial = round2(dto.initial_amount ?? 0);
    if (initial > float) throw new BadRequestException({ code: 'OVER_FLOAT', message: 'initial_amount cannot exceed the float limit', messageTh: 'เงินตั้งต้นเกินวงเงิน' });
    const glAccount = dto.gl_account ?? '1015';
    const [f] = await db.insert(pettyCashFunds).values({
      tenantId, fundCode: dto.fund_code, name: dto.name ?? null, custodian: dto.custodian ?? null, department: dto.department ?? null,
      glAccount, floatLimit: String(float), balance: '0', status: 'active', createdBy: user.username,
    }).onConflictDoNothing().returning({ id: pettyCashFunds.id });
    if (!f) throw new BadRequestException({ code: 'FUND_EXISTS', message: `Fund ${dto.fund_code} already exists`, messageTh: 'มีกองทุนนี้อยู่แล้ว' });
    await this.statusLog?.log('PCF', dto.fund_code, '', 'active', user.username);
    // The initial cash injection is a maker-checker funding request (no GL / no balance until approved).
    if (initial > 0) {
      const reqNo = await this.raiseFunding(Number(f!.id), dto.fund_code, tenantId, initial, user, `Establish petty cash ${dto.fund_code}`);
      return { fund_code: dto.fund_code, float_limit: float, balance: 0, gl_account: glAccount, funding_req_no: reqNo, pending: true };
    }
    return { fund_code: dto.fund_code, float_limit: float, balance: 0, gl_account: glAccount };
  }

  async replenishFund(fundCode: string, dto: ReplenishDto, user: JwtUser) {
    const fund = await this.fundByCode(fundCode, user);
    const amount = round2(dto.amount);
    if (!(amount > 0)) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'amount must be > 0', messageTh: 'จำนวนเงินต้องมากกว่าศูนย์' });
    const newBal = round2(n(fund.balance) + amount);
    if (newBal > n(fund.floatLimit) + 1e-9) throw new UnprocessableEntityException({ code: 'OVER_FLOAT', message: `Replenish would exceed the float limit ${n(fund.floatLimit)} (balance ${n(fund.balance)} + ${amount})`, messageTh: `เกินวงเงินของกองทุน (${n(fund.floatLimit)})` });
    // EXP-08 (audit G3): replenishment is a maker-checker funding request — the cash-in posts only on approval.
    const reqNo = await this.raiseFunding(Number(fund.id), fundCode, fund.tenantId ?? user.tenantId ?? null, amount, user, `Replenish petty cash ${fundCode}`);
    return { fund_code: fundCode, requested: amount, balance: n(fund.balance), float_limit: n(fund.floatLimit), funding_req_no: reqNo, pending: true };
  }

  // Raise a PendingApproval FUNDING request against a fund (maker; NO GL until a distinct user approves).
  private async raiseFunding(fundId: number, fundCode: string, tenantId: number | null, amount: number, user: JwtUser, purpose: string) {
    const reqNo = await this.docNo.nextDaily('PCF');
    await this.db.insert(expenseRequests).values({
      tenantId, reqNo, fundId, kind: 'funding', purpose, amount: String(amount),
      status: 'PendingApproval', requestedBy: user.username,
    });
    await this.statusLog?.log('PCF', reqNo, '', 'PendingApproval', user.username);
    await this.lineNotify?.notifyPermissionHolders(['creditors', 'exec'], tenantId,
      `🔔 รออนุมัติเติมเงินสดย่อย: ${reqNo} (${fundCode} ${amount} บาท โดย ${user.username})\nอนุมัติที่หน้า /petty-cash`, user.username);
    return reqNo;
  }

  async listFunds(user: JwtUser) {
    const db = this.db;
    const conds = user.tenantId != null ? [eq(pettyCashFunds.tenantId, user.tenantId)] : [];
    const rows = await db.select().from(pettyCashFunds).where(conds.length ? and(...conds) : undefined).orderBy(desc(pettyCashFunds.id));
    return { funds: rows.map(shapeFund), count: rows.length };
  }

  private async fundByCode(fundCode: string, user: JwtUser) {
    const db = this.db;
    const conds = [eq(pettyCashFunds.fundCode, fundCode)];
    if (user.tenantId != null) conds.push(eq(pettyCashFunds.tenantId, user.tenantId));
    const [f] = await db.select().from(pettyCashFunds).where(and(...conds)).limit(1);
    if (!f) throw new NotFoundException({ code: 'FUND_NOT_FOUND', message: `Fund ${fundCode} not found`, messageTh: 'ไม่พบกองทุนเงินสดย่อย' });
    return f;
  }

  // ── Request: a direct expense or an advance drawn against a fund (maker; NO GL until approved) ──
  // The draw cannot exceed the fund's available balance (the imprest float is finite).
  async createRequest(dto: ExpenseRequestDto, user: JwtUser) {
    const db = this.db;
    const fund = await this.fundByCode(dto.fund_code, user);
    if (fund.status !== 'active') throw new BadRequestException({ code: 'FUND_CLOSED', message: 'Fund is not active', messageTh: 'กองทุนปิดอยู่' });
    const amount = round2(dto.amount);
    if (!(amount > 0)) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'amount must be > 0', messageTh: 'จำนวนเงินต้องมากกว่าศูนย์' });
    if (amount > n(fund.balance) + 1e-9) throw new UnprocessableEntityException({ code: 'INSUFFICIENT_FLOAT', message: `Amount ${amount} exceeds the fund balance ${n(fund.balance)}`, messageTh: `จำนวนเงินเกินยอดคงเหลือในกองทุน (${n(fund.balance)})` });
    const reqNo = await this.docNo.nextDaily('PEX');
    let projectId: number | null = null; // M4 — resolve the optional project (404 on a bad code)
    if (dto.project_code?.trim()) {
      const [p] = await db.select({ id: projects.id }).from(projects).where(eq(projects.projectCode, dto.project_code.trim())).limit(1);
      if (!p) throw new BadRequestException({ code: 'PROJECT_NOT_FOUND', message: `Project ${dto.project_code} not found`, messageTh: 'ไม่พบโครงการ' });
      projectId = Number(p.id);
    }
    await db.insert(expenseRequests).values({
      tenantId: user.tenantId ?? null, reqNo, fundId: Number(fund.id), kind: dto.kind, payee: dto.payee ?? null, purpose: dto.purpose ?? null,
      amount: String(amount), projectId, boqLineId: dto.boq_line_id ?? null, expenseAccount: dto.expense_account ?? '5100', docRef: dto.doc_ref ?? null, receiptKey: dto.receipt_key ?? null,
      status: 'PendingApproval', requestedBy: user.username,
    });
    await this.statusLog?.log('PEX', reqNo, '', 'PendingApproval', user.username);
    await this.lineNotify?.notifyPermissionHolders(['creditors', 'exec'], user.tenantId ?? null,
      `🔔 รออนุมัติเบิกเงินสดย่อย: ${reqNo} (${dto.kind === 'advance' ? 'เงินยืม' : 'ค่าใช้จ่าย'} ${amount} บาท โดย ${user.username})${dto.purpose ? ` — ${dto.purpose}` : ''}\nอนุมัติที่หน้า /petty-cash`,
      user.username);
    return { req_no: reqNo, fund_code: dto.fund_code, kind: dto.kind, amount, status: 'PendingApproval', doc_ref: dto.doc_ref ?? null };
  }

  // ── Approve (checker ≠ maker): post GL + decrement the fund. Expense → Dr <acct> / Cr 1015;
  //    advance → Dr 1180 / Cr 1015. Re-checks the fund still has the cash. ──
  async approveRequest(reqNo: string, user: JwtUser) {
    const db = this.db;
    const req = await this.pendingRequest(reqNo, user);
    if (req.requestedBy && req.requestedBy === user.username)
      throw new ForbiddenException({ code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot approve an expense you requested', messageTh: 'แยกหน้าที่: ผู้ขอไม่สามารถอนุมัติรายการของตนเองได้' });
    // EXP-08 (audit G3): a FUNDING request (fund establishment / replenishment) posts the cash-in — Dr the
    // petty-cash account / Cr 1000 Cash — and lifts the fund balance, only on this independent approval.
    if (req.kind === 'funding') {
      const fund = (await db.select().from(pettyCashFunds).where(eq(pettyCashFunds.id, Number(req.fundId))).limit(1))[0];
      if (!fund) throw new NotFoundException({ code: 'FUND_NOT_FOUND', message: 'Fund not found', messageTh: 'ไม่พบกองทุน' });
      const amount = round2(n(req.amount));
      const newBal = round2(n(fund.balance) + amount);
      if (newBal > n(fund.floatLimit) + 1e-9) throw new UnprocessableEntityException({ code: 'OVER_FLOAT', message: `Funding would exceed the float limit ${n(fund.floatLimit)} (balance ${n(fund.balance)} + ${amount})`, messageTh: `เกินวงเงินของกองทุน (${n(fund.floatLimit)})` });
      const tenantId = req.tenantId ?? user.tenantId ?? null;
      let glRef: string | null = null;
      if (this.ledger) { const je: any = await this.ledger.postEntry({ date: ymd(), source: 'PCF', sourceRef: reqNo, tenantId, memo: `Fund petty cash ${fund.fundCode} — ${reqNo}`, createdBy: user.username, lines: [{ account_code: fund.glAccount, debit: amount }, { account_code: '1000', credit: amount }] }); glRef = je?.entry_no ?? null; }
      await db.update(pettyCashFunds).set({ balance: String(newBal) }).where(eq(pettyCashFunds.id, Number(fund.id)));
      await db.update(expenseRequests).set({ status: 'Approved', approvedBy: user.username, approvedAt: new Date(), glRef }).where(eq(expenseRequests.id, Number(req.id)));
      await this.statusLog?.log('PCF', reqNo, 'PendingApproval', 'Approved', user.username);
      if (req.requestedBy) await this.lineNotify?.notifyUser(req.requestedBy, tenantId, `✅ ${reqNo} เติมเงินสดย่อยอนุมัติแล้ว (โดย ${user.username}) — ${amount} บาท`);
      return { req_no: reqNo, kind: 'funding', fund_code: fund.fundCode, status: 'Approved', funded: amount, fund_balance: newBal, approved_by: user.username, prepared_by: req.requestedBy, journal_no: glRef };
    }
    const fund = (await db.select().from(pettyCashFunds).where(eq(pettyCashFunds.id, Number(req.fundId))).limit(1))[0];
    if (!fund) throw new NotFoundException({ code: 'FUND_NOT_FOUND', message: 'Fund not found', messageTh: 'ไม่พบกองทุน' });
    const amount = round2(n(req.amount));
    if (amount > n(fund.balance) + 1e-9) throw new UnprocessableEntityException({ code: 'INSUFFICIENT_FLOAT', message: `Fund balance ${n(fund.balance)} is now below the request ${amount}`, messageTh: 'ยอดคงเหลือในกองทุนไม่พอ' });
    const tenantId = req.tenantId ?? user.tenantId ?? null;
    const projectId = req.projectId ?? null; // M4 — the debit (advance/expense) carries the project dimension
    // docs/43 PR-2: request-level expenseAccount wins, then the tenant posting-rule (PETTY.EXPENSE), then default.
    const pexAcct = req.expenseAccount
      ?? (this.ledger ? (await this.ledger.postingOverrides('PETTY.EXPENSE', tenantId)).expense : undefined)
      ?? postingDefault('PETTY.EXPENSE', 'expense');
    const lines = req.kind === 'advance'
      ? [{ account_code: '1180', debit: amount, project_id: projectId }, { account_code: fund.glAccount, credit: amount }]
      : [{ account_code: pexAcct, debit: amount, project_id: projectId }, { account_code: fund.glAccount, credit: amount }];
    let glRef: string | null = null;
    if (this.ledger) { const je: any = await this.ledger.postEntry({ date: ymd(), source: 'PEX', sourceRef: reqNo, tenantId, memo: `${req.kind === 'advance' ? 'Advance' : 'Expense'} ${reqNo} — ${req.payee ?? ''}`, createdBy: user.username, lines }); glRef = je?.entry_no ?? null; }
    await db.update(pettyCashFunds).set({ balance: String(round2(n(fund.balance) - amount)) }).where(eq(pettyCashFunds.id, Number(fund.id)));
    await db.update(expenseRequests).set({ status: 'Approved', approvedBy: user.username, approvedAt: new Date(), glRef }).where(eq(expenseRequests.id, Number(req.id)));
    // FU1 (docs/32) — a project-tagged petty-cash spend CONSUMES its BoQ line's budget (consumed commitment,
    // allowOver so site cash never blocks). Best-effort: the GL/fund decrement already applied.
    if (this.commitments && req.projectId != null && req.boqLineId != null) {
      try {
        await db.transaction(async (tx: any) => {
          await this.commitments!.reserve(tx, { projectId: Number(req.projectId), boqLineId: Number(req.boqLineId), amount, qty: 0, sourceDocType: 'PEX', sourceDocNo: reqNo, createdBy: user.username, tenantId, allowOver: true });
          await this.commitments!.consume(tx, 'PEX', reqNo);
        });
      } catch { /* best-effort */ }
    }
    await this.statusLog?.log('PEX', reqNo, 'PendingApproval', 'Approved', user.username);
    if (req.requestedBy) await this.lineNotify?.notifyUser(req.requestedBy, tenantId, `✅ ${reqNo} อนุมัติแล้ว (โดย ${user.username}) — ${amount} บาท`);
    return { req_no: reqNo, kind: req.kind, status: 'Approved', amount, journal_no: glRef, approved_by: user.username, prepared_by: req.requestedBy, fund_balance: round2(n(fund.balance) - amount) };
  }

  async rejectRequest(reqNo: string, user: JwtUser, reason?: string) {
    const db = this.db;
    const req = await this.pendingRequest(reqNo, user);
    await db.update(expenseRequests).set({ status: 'Rejected', approvedBy: user.username, approvedAt: new Date(), rejectReason: reason ?? null }).where(eq(expenseRequests.id, Number(req.id)));
    await this.statusLog?.log('PEX', reqNo, 'PendingApproval', 'Rejected', user.username, reason);
    if (req.requestedBy) await this.lineNotify?.notifyUser(req.requestedBy, req.tenantId ?? user.tenantId ?? null, `❌ ${reqNo} ไม่ได้รับอนุมัติ (โดย ${user.username})${reason ? ` — ${reason}` : ''}`);
    return { req_no: reqNo, status: 'Rejected', rejected_by: user.username };
  }

  // ── Settle an approved ADVANCE: spend posts to the expense account, unused cash returns to the fund.
  //    settled_expense + returned_cash must equal the advance — Dr expense + Dr 1015 / Cr 1180. ──
  async settleRequest(reqNo: string, dto: SettleExpenseDto, user: JwtUser) {
    const db = this.db;
    const conds = [eq(expenseRequests.reqNo, reqNo)];
    if (user.tenantId != null) conds.push(eq(expenseRequests.tenantId, user.tenantId));
    const [req] = await db.select().from(expenseRequests).where(and(...conds)).limit(1);
    if (!req) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Expense request not found', messageTh: 'ไม่พบรายการ' });
    if (req.kind !== 'advance') throw new BadRequestException({ code: 'NOT_ADVANCE', message: 'Only advances are settled', messageTh: 'เฉพาะเงินเบิกล่วงหน้าที่ต้องเคลียร์' });
    if (req.status !== 'Approved') throw new BadRequestException({ code: 'NOT_APPROVED', message: 'Advance must be Approved (disbursed) before settling', messageTh: 'ต้องอนุมัติ (จ่าย) ก่อนจึงเคลียร์ได้' });
    const spent = round2(dto.settled_expense);
    const returned = round2(dto.returned_cash ?? 0);
    if (round2(spent + returned) !== round2(n(req.amount))) throw new BadRequestException({ code: 'SETTLE_MISMATCH', message: `settled_expense + returned_cash (${round2(spent + returned)}) must equal the advance (${n(req.amount)})`, messageTh: 'ยอดใช้จ่ายรวมเงินคืนต้องเท่ากับเงินเบิกล่วงหน้า' });
    const fund = (await db.select().from(pettyCashFunds).where(eq(pettyCashFunds.id, Number(req.fundId))).limit(1))[0];
    const glAccount = fund?.glAccount ?? '1015';
    const lines: any[] = [];
    // docs/43 PR-2: request-level expenseAccount wins, then the tenant posting-rule (PETTY.EXPENSE), then default.
    const stlAcct = req.expenseAccount
      ?? (this.ledger ? (await this.ledger.postingOverrides('PETTY.EXPENSE', req.tenantId ?? user.tenantId ?? null)).expense : undefined)
      ?? postingDefault('PETTY.EXPENSE', 'expense');
    if (spent > 0) lines.push({ account_code: stlAcct, debit: spent });
    if (returned > 0) lines.push({ account_code: glAccount, debit: returned });
    lines.push({ account_code: '1180', credit: round2(n(req.amount)) });
    if (this.ledger) await this.ledger.postEntry({ date: ymd(), source: 'PEX-STL', sourceRef: reqNo, tenantId: req.tenantId ?? user.tenantId ?? null, memo: `Settle advance ${reqNo}`, createdBy: user.username, lines });
    if (returned > 0 && fund) await db.update(pettyCashFunds).set({ balance: String(round2(n(fund.balance) + returned)) }).where(eq(pettyCashFunds.id, Number(fund.id)));
    await db.update(expenseRequests).set({ status: 'Settled', settledExpense: String(spent), returnedCash: String(returned), settledBy: user.username, settledAt: new Date() }).where(eq(expenseRequests.id, Number(req.id)));
    await this.statusLog?.log('PEX', reqNo, 'Approved', 'Settled', user.username);
    return { req_no: reqNo, status: 'Settled', settled_expense: spent, returned_cash: returned };
  }

  async listRequests(user: JwtUser, opts: { status?: string; fund_code?: string }) {
    const db = this.db;
    const conds: any[] = [];
    if (user.tenantId != null) conds.push(eq(expenseRequests.tenantId, user.tenantId));
    if (opts.status) conds.push(eq(expenseRequests.status, opts.status));
    const rows = await db.select().from(expenseRequests).where(conds.length ? and(...conds) : undefined).orderBy(desc(expenseRequests.id));
    return { requests: rows.map(shapeReq), count: rows.length };
  }

  private async pendingRequest(reqNo: string, user: JwtUser) {
    const db = this.db;
    const conds = [eq(expenseRequests.reqNo, reqNo), eq(expenseRequests.status, 'PendingApproval')];
    if (user.tenantId != null) conds.push(eq(expenseRequests.tenantId, user.tenantId));
    const [req] = await db.select().from(expenseRequests).where(and(...conds)).limit(1);
    if (!req) throw new BadRequestException({ code: 'NO_PENDING_REQUEST', message: `No expense request pending approval for ${reqNo}`, messageTh: 'ไม่มีรายการที่รออนุมัติ' });
    return req;
  }
}

function shapeFund(f: any) {
  return { fund_code: f.fundCode, name: f.name, custodian: f.custodian, department: f.department, gl_account: f.glAccount, float_limit: n(f.floatLimit), balance: n(f.balance), available: round2(n(f.floatLimit) - n(f.balance)), status: f.status, created_by: f.createdBy };
}
function shapeReq(r: any) {
  return { req_no: r.reqNo, kind: r.kind, payee: r.payee, purpose: r.purpose, amount: n(r.amount), expense_account: r.expenseAccount, doc_ref: r.docRef, receipt_key: r.receiptKey, status: r.status, requested_by: r.requestedBy, requested_at: r.requestedAt, approved_by: r.approvedBy, approved_at: r.approvedAt, reject_reason: r.rejectReason, settled_expense: r.settledExpense != null ? n(r.settledExpense) : null, returned_cash: r.returnedCash != null ? n(r.returnedCash) : null, journal_no: r.glRef };
}
