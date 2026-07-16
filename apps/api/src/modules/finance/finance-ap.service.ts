import { NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { sql, eq, and, asc, isNull } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { apTransactions, apPayments } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { StatusLogService } from '../../common/status-log.service';
import { LedgerService } from '../ledger/ledger.service';
import { postingDefault } from '../ledger/posting-events';
import { AccountDeterminationService } from '../ledger/account-determination.service';
import { ThreeWayMatchService } from '../match/three-way-match.service';
import { ymd, n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { assertMakerChecker } from '../../common/control-profile';
import type { ApTxnDto } from './finance.service';

const round2 = (x: number) => Math.round(x * 100) / 100;

// The shared VAT-resolution helpers stay on the FinanceService facade (they also serve the AR sync path)
// and arrive here as callback ports — the docs/38 port pattern, so this class never imports the facade.
export type VatSplitFn = (gross: number) => { net: number; vat: number };
export type VatLegFromCodeFn = (tenantId: number | null, code: string | null | undefined, amount: number, side: 'output' | 'input', opts?: { forceInclusive?: boolean }) => Promise<{ net: number; vat: number; gross: number; account: string } | null>;

// docs/46 Phase 4a cut 3 — the AP WRITE side of finance (bill entry incl. VAT/reverse-charge ภ.พ.36, and
// the EXP-06 disbursement maker-checker with TAX-03 withholding), moved VERBATIM out of finance.service.ts.
// A plain class constructed in the FinanceService constructor BODY (writeflow builds the facade positionally
// with 3 args — sub-services are never DI params); the facade keeps thin delegators, so the public API is
// byte-identical.
export class FinanceApService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly statusLog: StatusLogService,
    private readonly vatSplit: VatSplitFn,
    private readonly vatLegFromCode: VatLegFromCodeFn,
    private readonly ledger?: LedgerService,
    private readonly matchSvc?: ThreeWayMatchService, // Phase 16 — gates AP pay on 3-way match
    private readonly determination?: AccountDeterminationService,
  ) {}

  // POST /api/finance/ap/transactions — AP-
  async createApTxn(dto: ApTxnDto, user: JwtUser) {
    const db = this.db;
    // input VAT is per shop (ภ.พ.30) → tenant-scoped. An internal caller (e.g. ESS reimbursement, EAM
    // maintenance) may pin the AP to the source document's tenant via dto.tenant_id.
    const tenantId = dto.tenant_id ?? user.tenantId ?? null;
    // Maker-checker (EXP-06): a bill cannot be booked pre-paid in one call — that would disburse cash with no
    // second-person approval. Disbursement must go through requestApPayment → approveApPayment (always Unpaid here).
    if (n(dto.paid_amount) > 0) {
      throw new BadRequestException({ code: 'AP_PREPAID_BLOCKED', message: 'A bill cannot be created pre-paid; record the payment via the approval flow', messageTh: 'ห้ามสร้างบิลพร้อมจ่าย ต้องบันทึกการจ่ายผ่านการอนุมัติ' });
    }
    // Idempotency: a retried request with the same key returns the original bill (no duplicate payable/expense).
    if (dto.idempotency_key) {
      const tenantPred = tenantId != null ? eq(apTransactions.tenantId, tenantId) : isNull(apTransactions.tenantId);
      const [ex] = await db.select().from(apTransactions).where(and(tenantPred, eq(apTransactions.idempotencyKey, dto.idempotency_key))).limit(1);
      if (ex) return { txn_no: ex.txnNo, status: ex.status, idempotent: true };
    }
    const txnNo = await this.docNo.nextDaily('AP');
    // input VAT — a configured tax_code (docs/33 PR6) drives the rate + input-VAT GL account; else the flat
    // 7/107 default (exempt/zero-rated/non-VAT bills carry NO input VAT, else ภ.พ.30 overstates the credit).
    const treatment = dto.vat_treatment ?? 'standard';
    // ภ.พ.36 (ม.83/6) — imported services from an offshore/non-VAT-registered supplier: the supplier charges NO
    // Thai VAT, so the payer BOOKS THE BILL AT NET (gross = net, no vendor input-VAT leg) and SELF-ASSESSES 7%
    // output VAT to remit via ภ.พ.36, taking the mirror amount as a recoverable input-VAT credit. The
    // self-assessment posts Dr 1300 Input VAT / Cr 2120 PP36 VAT Payable (a wash on the P&L; the 2120 liability
    // is the remittance obligation the ภ.พ.36 report reads, kept out of the ภ.พ.30/2100 set).
    const reverseCharge = treatment === 'reverse_charge';
    const leg = reverseCharge ? null : await this.vatLegFromCode(tenantId, dto.tax_code, n(dto.amount), 'input');
    const fallback = treatment === 'standard' ? this.vatSplit(n(dto.amount)) : { net: n(dto.amount), vat: 0 };
    const net = leg ? leg.net : fallback.net;
    const vat = leg ? leg.vat : fallback.vat; // vendor input VAT on the bill (0 for reverse-charge — none exists)
    const apGross = leg ? leg.gross : n(dto.amount);
    const vatAccount = leg?.account ?? '2100';
    const selfVat = reverseCharge ? round2(net * 0.07) : 0; // ภ.พ.36 self-assessed output VAT (= recoverable input VAT)
    const paid = n(dto.paid_amount);
    const status = paid >= apGross ? 'Paid' : paid > 0 ? 'Partial' : 'Unpaid';
    await db.insert(apTransactions).values({
      txnNo, tenantId, vendorId: dto.vendor_id ?? null, vendorName: dto.vendor_name ?? null, txnType: dto.txn_type ?? 'Invoice',
      invoiceNo: dto.invoice_no ?? null, invoiceDate: dto.invoice_date ?? null, dueDate: dto.due_date ?? null,
      amount: String(apGross), vatAmount: fx(vat, 2), reverseCharge, paidAmount: String(paid), status, remarks: dto.remarks ?? null, idempotencyKey: dto.idempotency_key ?? null, createdBy: user.username,
    });
    // GL: record expense + input VAT + payable (Dr 5100/1200/override net / Dr <input-vat> vat / Cr 2000 gross). Zero VAT leg auto-drops.
    // For reverse-charge, append the ภ.พ.36 self-assessment pair (Dr 1300 / Cr 2120) — the whole entry stays balanced.
    if (this.ledger && apGross > 0) {
      const expenseAccount = dto.expense_account ?? ((dto.txn_type === 'Goods' || dto.txn_type === 'Inventory') ? '1200' : '5100');
      const lines = [{ account_code: expenseAccount, debit: net }, { account_code: vatAccount, debit: vat }, { account_code: '2000', credit: apGross }];
      if (selfVat > 0) {
        const rcOvr = await this.ledger.postingOverrides('RCVAT.SELF', tenantId);
        lines.push({ account_code: rcOvr.input_vat ?? postingDefault('RCVAT.SELF', 'input_vat'), debit: selfVat }, { account_code: rcOvr.pp36_payable ?? postingDefault('RCVAT.SELF', 'pp36_payable'), credit: selfVat });
      }
      await this.ledger.postEntry({
        date: dto.invoice_date ?? ymd(), source: 'AP', sourceRef: txnNo, tenantId,
        memo: `AP bill ${txnNo}${dto.vendor_name ? ' ' + dto.vendor_name : ''}${reverseCharge ? ' (ภ.พ.36 reverse-charge)' : ''}`, createdBy: user.username,
        lines,
      });
    }
    await this.statusLog.log('AP', txnNo, '', status, user.username);
    return { txn_no: txnNo, status };
  }

  // ───────────────────── AP disbursement maker-checker (AP-PAY) ─────────────────────
  // Step 1 (MAKER, `creditors`) — REQUEST a vendor payment. No cash moves and NO GL posts here: the bill's
  // paid_amount is untouched and a PendingApproval row is recorded. PATCH /api/finance/ap/transactions/{no}/pay
  async requestApPayment(txnNo: string, amount: number, user: JwtUser, idempotencyKey?: string, wht?: { income_type?: string; rate?: number; tax_code?: string }) {
    const db = this.db;
    const [t] = await db.select().from(apTransactions).where(eq(apTransactions.txnNo, txnNo)).limit(1);
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'AP txn not found', messageTh: 'ไม่พบรายการ AP' });
    // Phase 16 — 3-way match gate: a PO-based invoice must pass match (or be overridden) before payment.
    if (this.matchSvc) await this.matchSvc.assertPayable(txnNo);
    const apTenant = t.tenantId ?? user.tenantId ?? null;
    // Idempotency: a retried request with the same key returns the original pending payment (no duplicate).
    if (idempotencyKey) {
      const tenantPred = apTenant != null ? eq(apPayments.tenantId, apTenant) : isNull(apPayments.tenantId);
      const [ex] = await db.select().from(apPayments).where(and(tenantPred, eq(apPayments.idempotencyKey, idempotencyKey))).limit(1);
      if (ex) return { payment_no: ex.paymentNo, txn_no: txnNo, amount: n(ex.amount), status: ex.status, idempotent: true };
    }
    // Over-request guard: a new request cannot exceed outstanding minus payments already awaiting approval
    // (so two pending requests can't be approved into an overpayment).
    const [agg] = await db.select({ pend: sql<string>`coalesce(sum(${apPayments.amount}),0)` }).from(apPayments)
      .where(and(eq(apPayments.txnNo, txnNo), eq(apPayments.status, 'PendingApproval')));
    const outstanding = round2(n(t.amount) - n(t.paidAmount) - n(agg?.pend));
    if (n(amount) > outstanding + 0.001) {
      throw new BadRequestException({ code: 'AP_OVERPAY', message: `Amount ${amount} exceeds payable balance ${outstanding}`, messageTh: 'ยอดจ่ายเกินยอดคงค้าง (รวมรายการที่รออนุมัติ)' });
    }
    // TAX-03 — optional withholding tax (ภ.ง.ด.3/53). The rate is captured here; the amount is computed on the
    // pre-VAT base and posted to GL 2361 at approval (the actual cash/GL event). Bounded to a sane 0–30%.
    // docs/33 PR7: a WHT tax_code defaults the income type + rate when the caller omits them (makes the WHT
    // side of tax_codes live — ค่าจ้างทำของ/ค่าบริการ). An explicit income_type/rate still wins.
    let whtRate: number | null = wht?.rate ?? null;
    let whtIncome: string | null = wht?.income_type ?? null;
    if (wht?.tax_code && this.determination) {
      const tc = await this.determination.resolveTaxCode(apTenant, wht.tax_code);
      if (!tc || tc.kind !== 'wht') throw new BadRequestException({ code: 'INVALID_WHT_TAX_CODE', message: `Tax code '${wht.tax_code}' is not an active WHT code`, messageTh: `รหัสภาษี '${wht.tax_code}' ไม่ใช่รหัสหัก ณ ที่จ่ายที่ใช้งานอยู่` });
      whtIncome = whtIncome ?? tc.whtIncomeType ?? null;
      whtRate = whtRate ?? n(tc.rate);
    }
    if (whtRate != null && !(whtRate > 0 && whtRate <= 0.30)) {
      throw new BadRequestException({ code: 'INVALID_WHT_RATE', message: 'WHT rate must be between 0 and 0.30', messageTh: 'อัตราภาษีหัก ณ ที่จ่ายต้องอยู่ระหว่าง 0 ถึง 0.30' });
    }
    const paymentNo = await this.docNo.nextDaily('APP');
    await db.insert(apPayments).values({
      paymentNo, txnNo, tenantId: apTenant, amount: String(n(amount)), status: 'PendingApproval',
      requestedBy: user.username, glRef: `${txnNo}:p:${paymentNo}`, idempotencyKey: idempotencyKey ?? null,
      whtIncomeType: whtRate != null ? whtIncome : null, whtRate: whtRate != null ? String(whtRate) : null,
    });
    await this.statusLog.log('APP', paymentNo, '', 'PendingApproval', user.username, `Payment request ${n(amount)} for ${txnNo}${whtRate != null ? ` (WHT ${whtRate * 100}%)` : ''}`);
    return { payment_no: paymentNo, txn_no: txnNo, amount: n(amount), status: 'PendingApproval', wht_rate: whtRate };
  }

  // Step 2 (CHECKER, approval authority) — APPROVE a pending payment. The approver MUST differ from the
  // requester (segregation of duties) regardless of permissions held — even an Admin cannot approve their
  // own request. Only here does paid_amount move (under a row lock) and the cash-disbursement GL post.
  async approveApPayment(paymentNo: string, approver: JwtUser, selfApprovalReason?: string | null) {
    const db = this.db;
    const [p] = await db.select().from(apPayments).where(eq(apPayments.paymentNo, paymentNo)).limit(1);
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'AP payment not found', messageTh: 'ไม่พบรายการจ่าย' });
    if (p.status !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Payment ${paymentNo} is ${p.status}, not pending approval`, messageTh: 'รายการนี้ไม่ได้รออนุมัติ' });
    await assertMakerChecker(db, { user: approver, maker: p.requestedBy, event: 'ap.payment.approve', ref: paymentNo, amount: n(p.amount), reason: selfApprovalReason, code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot approve a payment you requested', messageTh: 'ผู้ขอจ่ายอนุมัติรายการของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    const apTenant = p.tenantId ?? approver.tenantId ?? null;
    let newPaid = 0; let billStatus = '';
    let billGross = 0, billVat = 0;
    await db.transaction(async (tx: any) => {
      // Lock the bill row and recompute from the LOCKED paid total → no lost update vs a concurrent approval.
      const [t] = await tx.select().from(apTransactions).where(eq(apTransactions.txnNo, p.txnNo)).for('update').limit(1);
      if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'AP txn not found', messageTh: 'ไม่พบรายการ AP' });
      billGross = n(t.amount); billVat = n(t.vatAmount);
      newPaid = round2(n(t.paidAmount) + n(p.amount));
      billStatus = newPaid >= n(t.amount) ? 'Paid' : newPaid > 0 ? 'Partial' : 'Unpaid';
      await tx.update(apTransactions).set({ paidAmount: String(newPaid), status: billStatus }).where(eq(apTransactions.id, t.id));
      await tx.update(apPayments).set({ status: 'Approved', approvedBy: approver.username, approvedAt: new Date() }).where(eq(apPayments.id, p.id));
    });
    // TAX-03 — withholding tax on this payment, computed on the PRE-VAT base (Thai WHT is on the fee, not VAT).
    // Prorate the base by the bill's net/gross ratio so partial payments withhold proportionally.
    const whtRate = n(p.whtRate);
    let whtAmount = 0;
    if (whtRate > 0) {
      const baseRatio = billGross > 0 ? (billGross - billVat) / billGross : 1;
      whtAmount = round2(round2(n(p.amount) * baseRatio) * whtRate);
    }
    // GL: clear the full payable (Dr 2000), hold the WHT (Cr 2361), pay the vendor net (Cr 1000). With no WHT
    // this is the original Dr 2000 / Cr 1000. The per-request glRef is stable + unique → idempotent post.
    if (this.ledger && n(p.amount) > 0 && !(await this.ledger.alreadyPosted('PAY-AP', p.glRef!, apTenant))) {
      const lines: any[] = [{ account_code: '2000', debit: n(p.amount) }];
      if (whtAmount > 0) {
        const whtOvr = await this.ledger.postingOverrides('APPAY.WHT', apTenant);
        lines.push({ account_code: whtOvr.wht_payable ?? postingDefault('APPAY.WHT', 'wht_payable'), credit: whtAmount });
      }
      lines.push({ account_code: '1000', credit: round2(n(p.amount) - whtAmount) });
      await this.ledger.postEntry({
        date: ymd(), source: 'PAY-AP', sourceRef: p.glRef ?? undefined, tenantId: apTenant,
        memo: `AP payment ${p.txnNo} (${paymentNo})${whtAmount > 0 ? ` — WHT ฿${whtAmount}` : ''}`, createdBy: approver.username,
        lines,
      });
      if (whtAmount > 0) await db.update(apPayments).set({ whtAmount: String(whtAmount) }).where(eq(apPayments.id, p.id));
    }
    await this.statusLog.log('APP', paymentNo, 'PendingApproval', 'Approved', approver.username);
    return { payment_no: paymentNo, txn_no: p.txnNo, status: 'Approved', approved_by: approver.username, requested_by: p.requestedBy, paid_amount: newPaid, bill_status: billStatus, wht_amount: whtAmount, net_paid: round2(n(p.amount) - whtAmount) };
  }

  // Step 2 (alt) — REJECT a pending payment (no cash/GL effect; recorded for the audit trail).
  async rejectApPayment(paymentNo: string, approver: JwtUser, reason?: string) {
    const db = this.db;
    const [p] = await db.select().from(apPayments).where(eq(apPayments.paymentNo, paymentNo)).limit(1);
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'AP payment not found', messageTh: 'ไม่พบรายการจ่าย' });
    if (p.status !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Payment ${paymentNo} is ${p.status}, not pending approval`, messageTh: 'รายการนี้ไม่ได้รออนุมัติ' });
    await db.update(apPayments).set({ status: 'Rejected', approvedBy: approver.username, approvedAt: new Date(), rejectReason: reason ?? null }).where(eq(apPayments.id, p.id));
    await this.statusLog.log('APP', paymentNo, 'PendingApproval', 'Rejected', approver.username, reason);
    return { payment_no: paymentNo, txn_no: p.txnNo, status: 'Rejected', rejected_by: approver.username };
  }

  // Checker queue — AP payments awaiting approval (joined to the bill for context).
  async listPendingApPayments(limit: number, offset: number) {
    const db = this.db;
    const rows = await db.select({
      payment_no: apPayments.paymentNo, txn_no: apPayments.txnNo, amount: apPayments.amount,
      requested_by: apPayments.requestedBy, requested_at: apPayments.requestedAt,
      vendor_name: apTransactions.vendorName, bill_amount: apTransactions.amount, paid_amount: apTransactions.paidAmount,
    }).from(apPayments).leftJoin(apTransactions, eq(apPayments.txnNo, apTransactions.txnNo))
      .where(eq(apPayments.status, 'PendingApproval')).orderBy(asc(apPayments.requestedAt)).limit(limit).offset(offset);
    const out = rows.map((r: any) => ({ ...r, amount: n(r.amount), bill_amount: n(r.bill_amount), paid_amount: n(r.paid_amount) }));
    return { payments: out, count: out.length };
  }
}
