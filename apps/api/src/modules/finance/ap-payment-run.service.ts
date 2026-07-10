import { Inject, Injectable, NotFoundException, BadRequestException, ForbiddenException, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { eq, and, ne, sql, lte, desc, asc, inArray, type SQL } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { apTransactions, apPayments, apPaymentRuns, apPaymentRunLines, bankAccounts, vendors, tenants } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { StatusLogService } from '../../common/status-log.service';
import { FinanceService } from './finance.service';
import { ThreeWayMatchService } from '../match/three-way-match.service';
import { AccountDeterminationService } from '../ledger/account-determination.service';
import { TaxJobsService } from '../tax/tax-jobs.service';
import { n, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

export interface ProposeRunDto {
  due_cutoff: string;                 // select open approved AP due on/before this date
  pay_date?: string;                  // intended value date (default = today, business TZ)
  bank_account_id: number;            // source house-bank for the bulk-transfer file
  vendor_ids?: number[];              // optional vendor filter
  vendor_name?: string;               // optional single-vendor filter (denormalized bills)
  early_pay_window_days?: number;     // "discount window": ALSO pull bills due within N days AFTER the
                                      // cutoff (early-payment-discount candidates, flagged per line)
  wht_tax_code?: string;              // optional default WHT code applied to every selected line
  remarks?: string;
}
export interface EditRunLinesDto {
  remove_line_ids?: number[];
  update?: { line_id: number; amount?: number; wht_tax_code?: string | null; wht_rate?: number | null; wht_income_type?: string | null }[];
}

// AP payment run + Thai bank payment file (FIN-2, control EXP-13). A thin BATCH lifecycle over the existing
// one-by-one AP-PAY maker-checker: proposal (due-date selection, 3-way-match gated per line, WHT via the
// same tax-code resolution as a manual payment) → distinct-approver approval (SOD_VIOLATION on
// self-approval, mirrors EXP-06) → execution through the EXISTING requestApPayment→approveApPayment path
// (identical GL + WHT postings, idempotent per line) → bank bulk-transfer file (SHA-256 pinned on the run +
// status-logged) → bank-statement clearing (BankService.autoMatch flips line.cleared).
@Injectable()
export class ApPaymentRunService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly statusLog: StatusLogService,
    private readonly finance: FinanceService,
    private readonly matchSvc: ThreeWayMatchService,
    // Optional so partially-wired harnesses stay constructible (pattern: FinanceService's optional deps).
    @Optional() private readonly determination?: AccountDeterminationService,
    @Optional() private readonly taxJobs?: TaxJobsService,
  ) {}

  // ── Resolve + validate a WHT tax code exactly like a manual payment request (TAX-03 / docs/33 PR7) ──
  private async resolveWht(tenantId: number | null, taxCode: string | null | undefined, rate?: number | null, incomeType?: string | null):
    Promise<{ code: string | null; rate: number | null; income: string | null }> {
    let whtRate: number | null = rate ?? null;
    let whtIncome: string | null = incomeType ?? null;
    if (taxCode) {
      if (!this.determination) throw new BadRequestException({ code: 'INVALID_WHT_TAX_CODE', message: 'Tax-code resolution unavailable', messageTh: 'ระบบรหัสภาษีไม่พร้อมใช้งาน' });
      const tc = await this.determination.resolveTaxCode(tenantId, taxCode);
      if (!tc || tc.kind !== 'wht') throw new BadRequestException({ code: 'INVALID_WHT_TAX_CODE', message: `Tax code '${taxCode}' is not an active WHT code`, messageTh: `รหัสภาษี '${taxCode}' ไม่ใช่รหัสหัก ณ ที่จ่ายที่ใช้งานอยู่` });
      whtIncome = whtIncome ?? tc.whtIncomeType ?? null;
      whtRate = whtRate ?? n(tc.rate);
    }
    if (whtRate != null && !(whtRate > 0 && whtRate <= 0.30)) {
      throw new BadRequestException({ code: 'INVALID_WHT_RATE', message: 'WHT rate must be between 0 and 0.30', messageTh: 'อัตราภาษีหัก ณ ที่จ่ายต้องอยู่ระหว่าง 0 ถึง 0.30' });
    }
    return { code: taxCode ?? null, rate: whtRate, income: whtIncome };
  }

  // Estimated WHT for a line — the SAME formula approveApPayment applies at posting time (pre-VAT base,
  // prorated by the bill's net/gross ratio). Recomputed authoritatively at execution.
  private estimateWht(payAmount: number, billGross: number, billVat: number, rate: number | null): number {
    if (!rate || !(rate > 0)) return 0;
    const baseRatio = billGross > 0 ? (billGross - billVat) / billGross : 1;
    return round2(round2(payAmount * baseRatio) * rate);
  }

  private async loadRun(runNo: string) {
    const [run] = await this.db.select().from(apPaymentRuns).where(eq(apPaymentRuns.runNo, runNo)).limit(1);
    if (!run) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Payment run not found', messageTh: 'ไม่พบรอบจ่ายเงิน' });
    return run;
  }

  private async recomputeTotals(runId: number) {
    const [agg] = await this.db.select({
      amt: sql<string>`coalesce(sum(${apPaymentRunLines.amount}),0)`,
      wht: sql<string>`coalesce(sum(coalesce(${apPaymentRunLines.whtAmount},0)),0)`,
      net: sql<string>`coalesce(sum(coalesce(${apPaymentRunLines.netAmount},${apPaymentRunLines.amount})),0)`,
      cnt: sql<string>`count(*)`,
    }).from(apPaymentRunLines).where(eq(apPaymentRunLines.runId, runId));
    await this.db.update(apPaymentRuns).set({
      totalAmount: String(round2(n(agg?.amt))), totalWht: String(round2(n(agg?.wht))),
      totalNet: String(round2(n(agg?.net))), lineCount: Number(agg?.cnt ?? 0),
    }).where(eq(apPaymentRuns.id, runId));
  }

  // ── PROPOSE (maker, `creditors`) — select open approved AP by due-date cutoff into a Draft run ──
  async propose(dto: ProposeRunDto, user: JwtUser) {
    const db = this.db;
    if (!dto.due_cutoff) throw new BadRequestException({ code: 'CUTOFF_REQUIRED', message: 'due_cutoff is required', messageTh: 'ต้องระบุวันครบกำหนดตัดรอบ' });
    const tenantId = user.tenantId ?? null;
    // Source house-bank must exist and be maker-checker Approved (G9 gate, mirrors createDeposit).
    const [bank] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, dto.bank_account_id)).limit(1);
    if (!bank) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Bank account not found', messageTh: 'ไม่พบบัญชีธนาคาร' });
    if (bank.status !== 'Approved') throw new BadRequestException({ code: 'BANK_NOT_APPROVED', message: 'Bank account is pending approval and cannot be used yet', messageTh: 'บัญชีธนาคารรออนุมัติ ยังใช้งานไม่ได้' });

    // Selection window: open bills due on/before the cutoff; the optional "discount window" ALSO pulls
    // bills due within N days after it (early-payment candidates — no discount master exists yet, so the
    // flag widens the selection and marks the line; see PN-02 §7(8b)).
    const early = Math.max(0, Math.min(60, Number(dto.early_pay_window_days ?? 0) || 0));
    const hi = early > 0 ? addDaysYmd(dto.due_cutoff, early) : dto.due_cutoff;
    const conds: SQL[] = [sql`${apTransactions.status}::text <> 'Paid'`, lte(apTransactions.dueDate, hi)];
    if (tenantId != null) conds.push(eq(apTransactions.tenantId, tenantId));
    if (dto.vendor_ids?.length) conds.push(inArray(apTransactions.vendorId, dto.vendor_ids.map(Number)));
    if (dto.vendor_name) conds.push(eq(apTransactions.vendorName, dto.vendor_name));
    const bills = await db.select().from(apTransactions).where(and(...conds)).orderBy(asc(apTransactions.dueDate), asc(apTransactions.id)).limit(500);

    // Bills already selected in another OPEN run must not be double-proposed (the per-line over-request
    // guard at execution backstops, but the file-level dedup belongs here).
    const openRuns = await db.select({ id: apPaymentRuns.id }).from(apPaymentRuns)
      .where(and(inArray(apPaymentRuns.status, ['Draft', 'PendingApproval', 'Approved']), tenantId != null ? eq(apPaymentRuns.tenantId, tenantId) : sql`true`));
    const openRunIds = openRuns.map((r) => Number(r.id));
    const inOpen = new Set<string>(openRunIds.length
      ? (await db.select({ t: apPaymentRunLines.txnNo }).from(apPaymentRunLines).where(inArray(apPaymentRunLines.runId, openRunIds))).map((r) => String(r.t))
      : []);

    const wht = await this.resolveWht(tenantId, dto.wht_tax_code);
    const lines: (typeof apPaymentRunLines.$inferInsert)[] = [];
    const skipped: { txn_no: string; reason: string }[] = [];
    for (const t of bills) {
      if (inOpen.has(String(t.txnNo))) { skipped.push({ txn_no: t.txnNo, reason: 'IN_OPEN_RUN' }); continue; }
      // Outstanding minus payments already awaiting approval (same aggregate as the manual over-request guard).
      const [agg] = await db.select({ pend: sql<string>`coalesce(sum(${apPayments.amount}),0)` }).from(apPayments)
        .where(and(eq(apPayments.txnNo, t.txnNo), eq(apPayments.status, 'PendingApproval')));
      const outstanding = round2(n(t.amount) - n(t.paidAmount) - n(agg?.pend));
      if (!(outstanding > 0)) { skipped.push({ txn_no: t.txnNo, reason: 'NOTHING_OUTSTANDING' }); continue; }
      // 3-way-match payment gate (EXP-09): a blocked PO invoice never enters the run.
      try { await this.matchSvc.assertPayable(t.txnNo); } catch { skipped.push({ txn_no: t.txnNo, reason: 'MATCH_BLOCKED' }); continue; }
      const whtAmount = this.estimateWht(outstanding, n(t.amount), n(t.vatAmount), wht.rate);
      lines.push({
        runId: 0, tenantId: t.tenantId ?? tenantId, txnNo: t.txnNo, vendorId: t.vendorId ?? null, vendorName: t.vendorName ?? null,
        dueDate: t.dueDate ?? null, billAmount: String(n(t.amount)), amount: String(outstanding),
        whtTaxCode: wht.code, whtIncomeType: wht.rate != null ? wht.income : null,
        whtRate: wht.rate != null ? String(wht.rate) : null,
        whtAmount: wht.rate != null ? String(whtAmount) : null,
        netAmount: String(round2(outstanding - whtAmount)), status: 'Selected',
      });
    }
    if (!lines.length) throw new BadRequestException({ code: 'NO_ELIGIBLE_AP', message: 'No open approved AP bills match the selection', messageTh: 'ไม่มีบิลเจ้าหนี้ค้างจ่ายตามเงื่อนไขที่เลือก', skipped });

    const runNo = await this.docNo.nextDaily('APRUN');
    const [head] = await db.insert(apPaymentRuns).values({
      runNo, tenantId, status: 'Draft', payDate: dto.pay_date ?? ymd(), dueCutoff: dto.due_cutoff,
      bankAccountId: dto.bank_account_id, createdBy: user.username, remarks: dto.remarks ?? null,
    }).returning({ id: apPaymentRuns.id });
    const runId = Number(head!.id);
    await db.insert(apPaymentRunLines).values(lines.map((l) => ({ ...l, runId })));
    await this.recomputeTotals(runId);
    await this.statusLog.log('APRUN', runNo, '', 'Draft', user.username, `Proposed ${lines.length} lines (cutoff ${dto.due_cutoff})`);
    return { ...(await this.get(runNo)), skipped };
  }

  // ── Edit lines (maker) — Draft only ──
  async editLines(runNo: string, dto: EditRunLinesDto, user: JwtUser) {
    const db = this.db;
    const run = await this.loadRun(runNo);
    if (run.status !== 'Draft') throw new BadRequestException({ code: 'NOT_DRAFT', message: `Run ${runNo} is ${run.status}; lines are editable only while Draft`, messageTh: 'แก้ไขรายการได้เฉพาะรอบจ่ายสถานะร่างเท่านั้น' });
    if (dto.remove_line_ids?.length) {
      await db.delete(apPaymentRunLines).where(and(eq(apPaymentRunLines.runId, Number(run.id)), inArray(apPaymentRunLines.id, dto.remove_line_ids.map(Number))));
    }
    for (const u of dto.update ?? []) {
      const [line] = await db.select().from(apPaymentRunLines).where(and(eq(apPaymentRunLines.runId, Number(run.id)), eq(apPaymentRunLines.id, Number(u.line_id)))).limit(1);
      if (!line) throw new NotFoundException({ code: 'LINE_NOT_FOUND', message: `Line ${u.line_id} not in run ${runNo}`, messageTh: 'ไม่พบรายการในรอบจ่ายนี้' });
      const [bill] = await db.select().from(apTransactions).where(eq(apTransactions.txnNo, line.txnNo)).limit(1);
      const amount = u.amount != null ? round2(u.amount) : n(line.amount);
      if (!(amount > 0)) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'Line amount must be > 0', messageTh: 'จำนวนเงินต้องมากกว่าศูนย์' });
      const outstanding = round2(n(bill?.amount) - n(bill?.paidAmount));
      if (amount > outstanding + 0.001) throw new BadRequestException({ code: 'AP_OVERPAY', message: `Amount ${amount} exceeds payable balance ${outstanding} of ${line.txnNo}`, messageTh: 'ยอดจ่ายเกินยอดคงค้างของบิล' });
      // Re-resolve WHT with the same rules as a manual payment. Passing wht_tax_code=null clears it.
      const clearWht = u.wht_tax_code === null && u.wht_rate == null;
      const wht = clearWht ? { code: null, rate: null, income: null } : await this.resolveWht(run.tenantId ?? null, u.wht_tax_code ?? line.whtTaxCode, u.wht_rate ?? (u.wht_tax_code ? null : n(line.whtRate) || null), u.wht_income_type ?? line.whtIncomeType);
      const whtAmount = this.estimateWht(amount, n(bill?.amount), n(bill?.vatAmount), wht.rate);
      await db.update(apPaymentRunLines).set({
        amount: String(amount), whtTaxCode: wht.code, whtIncomeType: wht.rate != null ? wht.income : null,
        whtRate: wht.rate != null ? String(wht.rate) : null, whtAmount: wht.rate != null ? String(whtAmount) : null,
        netAmount: String(round2(amount - whtAmount)),
      }).where(eq(apPaymentRunLines.id, Number(line.id)));
    }
    await this.recomputeTotals(Number(run.id));
    await this.statusLog.log('APRUN', runNo, 'Draft', 'Draft', user.username, 'Lines edited');
    return this.get(runNo);
  }

  // ── Submit for approval (maker) ──
  async submit(runNo: string, user: JwtUser) {
    const run = await this.loadRun(runNo);
    if (run.status !== 'Draft') throw new BadRequestException({ code: 'NOT_DRAFT', message: `Run ${runNo} is ${run.status}`, messageTh: 'รอบจ่ายนี้ไม่ได้อยู่ในสถานะร่าง' });
    if (!Number(run.lineCount)) throw new BadRequestException({ code: 'EMPTY_RUN', message: 'Run has no lines', messageTh: 'รอบจ่ายไม่มีรายการ' });
    await this.db.update(apPaymentRuns).set({ status: 'PendingApproval', submittedAt: new Date() }).where(eq(apPaymentRuns.id, Number(run.id)));
    await this.statusLog.log('APRUN', runNo, 'Draft', 'PendingApproval', user.username);
    return { run_no: runNo, status: 'PendingApproval' };
  }

  // ── Approve (checker, `approvals`/`gl_close`) — approver ≠ proposer, binds even Admin (EXP-13) ──
  async approve(runNo: string, approver: JwtUser) {
    const db = this.db;
    const run = await this.loadRun(runNo);
    if (run.status !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Run ${runNo} is ${run.status}, not pending approval`, messageTh: 'รอบจ่ายนี้ไม่ได้รออนุมัติ' });
    if (run.createdBy && run.createdBy === approver.username) {
      throw new ForbiddenException({ code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot approve a payment run you proposed', messageTh: 'ผู้จัดทำรอบจ่ายอนุมัติรอบของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    }
    // Re-run the 3-way-match gate per line at approval — a bill blocked since proposal must not ride through.
    const lines = await db.select().from(apPaymentRunLines).where(eq(apPaymentRunLines.runId, Number(run.id)));
    for (const l of lines) {
      try {
        await this.matchSvc.assertPayable(l.txnNo);
      } catch {
        throw new BadRequestException({ code: 'MATCH_BLOCKED', message: `Line ${l.txnNo} is blocked by the 3-way match; remove it or resolve the match first`, messageTh: `บิล ${l.txnNo} ถูกระงับโดยการจับคู่ 3 ทาง — นำออกจากรอบหรือแก้ไขก่อน` });
      }
    }
    await db.update(apPaymentRuns).set({ status: 'Approved', approvedBy: approver.username, approvedAt: new Date() }).where(eq(apPaymentRuns.id, Number(run.id)));
    await this.statusLog.log('APRUN', runNo, 'PendingApproval', 'Approved', approver.username);
    return { run_no: runNo, status: 'Approved', approved_by: approver.username, proposed_by: run.createdBy };
  }

  // ── Reject (checker) — no cash/GL effect ──
  async reject(runNo: string, approver: JwtUser, reason?: string) {
    const run = await this.loadRun(runNo);
    if (run.status !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Run ${runNo} is ${run.status}, not pending approval`, messageTh: 'รอบจ่ายนี้ไม่ได้รออนุมัติ' });
    await this.db.update(apPaymentRuns).set({ status: 'Rejected', approvedBy: approver.username, approvedAt: new Date(), rejectReason: reason ?? null }).where(eq(apPaymentRuns.id, Number(run.id)));
    await this.statusLog.log('APRUN', runNo, 'PendingApproval', 'Rejected', approver.username, reason);
    return { run_no: runNo, status: 'Rejected', rejected_by: approver.username };
  }

  // ── Cancel (maker) — Draft/PendingApproval only ──
  async cancel(runNo: string, user: JwtUser) {
    const run = await this.loadRun(runNo);
    if (run.status !== 'Draft' && run.status !== 'PendingApproval') {
      throw new BadRequestException({ code: 'NOT_CANCELLABLE', message: `Run ${runNo} is ${run.status} and cannot be cancelled`, messageTh: 'ยกเลิกได้เฉพาะรอบจ่ายที่ยังไม่อนุมัติ' });
    }
    await this.db.update(apPaymentRuns).set({ status: 'Cancelled' }).where(eq(apPaymentRuns.id, Number(run.id)));
    await this.statusLog.log('APRUN', runNo, String(run.status), 'Cancelled', user.username);
    return { run_no: runNo, status: 'Cancelled' };
  }

  // ── EXECUTE (approvals/gl_close; executor ≠ proposer) — post each line through the EXISTING AP payment
  // path: requestApPayment AS the proposer (maker credit + idempotency + gates) then approveApPayment AS an
  // independent checker (row-locked paid_amount + the SAME GL/WHT posting as a manual payment). Idempotent
  // per line (`run:<runNo>:<lineId>` idempotency key + Paid-line skip); a partial failure leaves the run
  // 'Approved' with per-line status so a re-execute retries only the failed lines. ──
  async execute(runNo: string, executor: JwtUser) {
    const db = this.db;
    const run = await this.loadRun(runNo);
    if (run.status !== 'Approved' && run.status !== 'Executed') {
      throw new BadRequestException({ code: 'NOT_APPROVED', message: `Run ${runNo} is ${run.status}, not approved for execution`, messageTh: 'รอบจ่ายยังไม่ได้รับอนุมัติ' });
    }
    if (run.status === 'Executed') return { ...(await this.get(runNo)), idempotent: true };
    if (run.createdBy && run.createdBy === executor.username) {
      throw new ForbiddenException({ code: 'SOD_VIOLATION', message: 'Maker-checker: the proposer cannot execute the run (cash release is a checker act)', messageTh: 'ผู้จัดทำรอบจ่ายสั่งจ่ายเองไม่ได้ (แบ่งแยกหน้าที่)' });
    }
    // Per-line maker/checker identities for the existing path: the request is attributed to the run's
    // PROPOSER (maker), the approval to the independent EXECUTOR (checker ≠ proposer, enforced above and
    // re-enforced per payment by approveApPayment's own SoD check).
    const maker: JwtUser = { username: String(run.createdBy ?? executor.username), role: 'system', customerName: null, tenantId: run.tenantId ?? null, permissions: [] };
    const lines = await db.select().from(apPaymentRunLines).where(eq(apPaymentRunLines.runId, Number(run.id))).orderBy(asc(apPaymentRunLines.id));
    let paid = 0, failed = 0, skippedPaid = 0;
    const results: { line_id: number; txn_no: string; status: string; payment_no?: string; wht_amount?: number; error?: string }[] = [];
    for (const l of lines) {
      if (l.status === 'Paid') { skippedPaid++; results.push({ line_id: Number(l.id), txn_no: l.txnNo, status: 'Paid', payment_no: l.paymentNo ?? undefined }); continue; }
      try {
        const req = await this.finance.requestApPayment(l.txnNo, n(l.amount), maker, `run:${runNo}:${Number(l.id)}`,
          l.whtRate != null ? { income_type: l.whtIncomeType ?? undefined, rate: n(l.whtRate) } : undefined);
        const paymentNo = String(req.payment_no);
        let whtAmount = 0;
        // A retried execute may find the payment already approved (idempotent per line).
        const [p] = await db.select().from(apPayments).where(eq(apPayments.paymentNo, paymentNo)).limit(1);
        if (p?.status === 'Approved') { whtAmount = n(p.whtAmount); }
        else {
          const ap = await this.finance.approveApPayment(paymentNo, executor);
          whtAmount = n(ap.wht_amount);
        }
        await db.update(apPaymentRunLines).set({
          status: 'Paid', paymentNo, glRef: `${l.txnNo}:p:${paymentNo}`, failReason: null,
          whtAmount: String(whtAmount), netAmount: String(round2(n(l.amount) - whtAmount)),
        }).where(eq(apPaymentRunLines.id, Number(l.id)));
        paid++;
        results.push({ line_id: Number(l.id), txn_no: l.txnNo, status: 'Paid', payment_no: paymentNo, wht_amount: whtAmount });
      } catch (e) {
        const err = e as { response?: { code?: string; error?: { code?: string } }; message?: string };
        const code = err?.response?.code ?? err?.response?.error?.code ?? err?.message ?? 'EXECUTE_FAILED';
        failed++;
        await db.update(apPaymentRunLines).set({ status: 'Failed', failReason: String(code) }).where(eq(apPaymentRunLines.id, Number(l.id)));
        results.push({ line_id: Number(l.id), txn_no: l.txnNo, status: 'Failed', error: String(code) });
      }
    }
    await this.recomputeTotals(Number(run.id));
    const allPaid = failed === 0;
    if (allPaid) {
      await db.update(apPaymentRuns).set({ status: 'Executed', executedBy: executor.username, executedAt: new Date() }).where(eq(apPaymentRuns.id, Number(run.id)));
    }
    await this.statusLog.log('APRUN', runNo, 'Approved', allPaid ? 'Executed' : 'Approved', executor.username, `Executed: ${paid} paid, ${failed} failed, ${skippedPaid} already paid`);
    // WHT certificates (50-ทวิ) for every executed WHT line — the EXISTING idempotent batch cert job.
    let whtCerts: { issued: number; skipped: number } | null = null;
    if (this.taxJobs && (paid > 0)) {
      try { const r = await this.taxJobs.runWhtCertBatch(executor); whtCerts = { issued: r.issued ?? 0, skipped: r.skipped ?? 0 }; } catch { whtCerts = null; }
    }
    return { run_no: runNo, status: allPaid ? 'Executed' : 'Approved', executed_by: executor.username, paid, failed, already_paid: skippedPaid, lines: results, wht_certs: whtCerts };
  }

  // ── Reads ──
  async list(user: JwtUser, status?: string, limit = 50) {
    const conds: SQL[] = [];
    if (user.tenantId != null) conds.push(eq(apPaymentRuns.tenantId, user.tenantId));
    if (status) conds.push(eq(apPaymentRuns.status, status));
    const rows = await this.db.select().from(apPaymentRuns).where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(apPaymentRuns.id)).limit(Math.min(Math.max(limit, 1), 200));
    return { runs: rows.map(shapeRun), count: rows.length };
  }

  async get(runNo: string) {
    const run = await this.loadRun(runNo);
    const lines = await this.db.select().from(apPaymentRunLines).where(eq(apPaymentRunLines.runId, Number(run.id))).orderBy(asc(apPaymentRunLines.id));
    const clearedCount = lines.filter((l) => !!l.cleared).length;
    const paidCount = lines.filter((l) => l.status === 'Paid').length;
    return {
      ...shapeRun(run),
      lines: lines.map((l) => ({
        line_id: Number(l.id), txn_no: l.txnNo, vendor_id: l.vendorId != null ? Number(l.vendorId) : null, vendor_name: l.vendorName,
        due_date: l.dueDate, bill_amount: n(l.billAmount), amount: n(l.amount),
        wht_tax_code: l.whtTaxCode, wht_income_type: l.whtIncomeType, wht_rate: l.whtRate != null ? n(l.whtRate) : null,
        wht_amount: n(l.whtAmount), net_amount: n(l.netAmount), status: l.status,
        payment_no: l.paymentNo, fail_reason: l.failReason, cleared: !!l.cleared, cleared_at: l.clearedAt ?? null,
      })),
      cleared_count: clearedCount, paid_count: paidCount,
      cleared_progress: paidCount > 0 ? round2(clearedCount / paidCount) : 0,
    };
  }

  // ── Thai bank bulk-transfer file (generic CSV + named presets) / minimal ISO 20022 pain.001 XML.
  // The layouts are DOCUMENTED, CONFIGURABLE presets (see PN-02 §7(8b)) — column orders for scb/kbank/bbl
  // follow the common Thai cash-management bulk-upload shape (header/detail/trailer records) and are meant
  // to be adjusted to the bank's current template before go-live. The file's SHA-256 is pinned on the run
  // and status-logged so the file handed to the bank is provably the file the run generated (EXP-13). ──
  async bankFile(runNo: string, format: string | undefined, user: JwtUser): Promise<{ filename: string; contentType: string; body: string; sha256: string }> {
    const db = this.db;
    const run = await this.loadRun(runNo);
    // Use the run's canonical, DB-sourced run_no (APRUN-YYYYMMDD-NNN) everywhere below — never the raw
    // path param — so no request-controlled value is reflected into the filename/headers or the file body.
    const canonicalRunNo = run.runNo;
    if (run.status !== 'Approved' && run.status !== 'Executed') {
      throw new BadRequestException({ code: 'RUN_NOT_APPROVED', message: `Bank file is available only for an approved/executed run (run is ${run.status})`, messageTh: 'สร้างไฟล์ธนาคารได้เฉพาะรอบจ่ายที่อนุมัติแล้ว' });
    }
    const fmt = (format ?? 'generic').toLowerCase();
    if (!['generic', 'scb', 'kbank', 'bbl', 'iso20022'].includes(fmt)) {
      throw new BadRequestException({ code: 'UNSUPPORTED_FILE_FORMAT', message: `Unsupported bank-file format '${format}'`, messageTh: 'ไม่รองรับรูปแบบไฟล์นี้ (generic | scb | kbank | bbl | iso20022)' });
    }
    const [bank] = run.bankAccountId != null ? await db.select().from(bankAccounts).where(eq(bankAccounts.id, Number(run.bankAccountId))).limit(1) : [null];
    const [payer] = run.tenantId != null ? await db.select().from(tenants).where(eq(tenants.id, Number(run.tenantId))).limit(1) : [null];
    const lines = await db.select().from(apPaymentRunLines).where(and(eq(apPaymentRunLines.runId, Number(run.id)), ne(apPaymentRunLines.status, 'Failed'))).orderBy(asc(apPaymentRunLines.id));
    if (!lines.length) throw new BadRequestException({ code: 'EMPTY_RUN', message: 'Run has no payable lines', messageTh: 'รอบจ่ายไม่มีรายการที่จ่ายได้' });

    // Beneficiary bank details come from the vendor master at the payment boundary (encrypted at rest,
    // ITGC-AC-19). FAIL CLOSED on a missing account: a bulk file with blank beneficiaries is a mispay risk.
    const vendorIds = [...new Set(lines.map((l) => l.vendorId).filter((v): v is number => v != null).map(Number))];
    const vrows = vendorIds.length ? await db.select().from(vendors).where(inArray(vendors.id, vendorIds)) : [];
    const vmap = new Map<number, typeof vendors.$inferSelect>(vrows.map((v) => [Number(v.id), v]));
    const missing: string[] = [];
    const details = lines.map((l, i) => {
      const v = l.vendorId != null ? vmap.get(Number(l.vendorId)) : undefined;
      const acct = (v?.bankAccount ?? '').replace(/[^0-9]/g, '');
      const bankName = v?.bankName ?? '';
      if (!acct) missing.push(`${l.txnNo} (${l.vendorName ?? v?.name ?? 'vendor ' + (l.vendorId ?? '?')})`);
      return {
        seq: i + 1, beneficiary_bank: bankName, beneficiary_account: acct,
        beneficiary_name: v?.name ?? l.vendorName ?? '', amount: n(l.netAmount ?? l.amount),
        ref: l.txnNo, wht: n(l.whtAmount),
      };
    });
    if (missing.length) {
      throw new BadRequestException({ code: 'VENDOR_BANK_MISSING', message: `Vendor bank account missing for: ${missing.join(', ')} — record the beneficiary account on the vendor master (bank-detail changes are maker-checked, EXP-11)`, messageTh: 'ไม่มีเลขบัญชีธนาคารของผู้ขาย — บันทึกในทะเบียนผู้ขายก่อนสร้างไฟล์' });
    }
    const total = round2(details.reduce((a, d) => a + d.amount, 0));
    const payDate = String(run.payDate ?? ymd());
    const debitAcct = (bank?.accountNo ?? '').replace(/[^0-9]/g, '');

    let body: string; let contentType = 'text/csv; charset=utf-8'; let ext = 'csv';
    if (fmt === 'iso20022') {
      body = pain001Xml({ runNo: canonicalRunNo, payDate, debitAcct, debitName: payer?.legalName ?? payer?.name ?? '', details, total });
      contentType = 'application/xml; charset=utf-8'; ext = 'xml';
    } else {
      body = thaiBulkCsv(fmt, { runNo: canonicalRunNo, payDate, debitAcct, debitBank: bank?.bankName ?? '', debitName: payer?.legalName ?? payer?.name ?? '', details, total });
    }
    const sha256 = createHash('sha256').update(body, 'utf8').digest('hex');
    await db.update(apPaymentRuns).set({ fileFormat: fmt, fileHash: sha256, fileGeneratedAt: new Date() }).where(eq(apPaymentRuns.id, Number(run.id)));
    // Audit event — the hash of the exact bytes handed to the bank (EXP-13 evidence; GETs skip the
    // mutating-request audit interceptor, so the status log carries it).
    await this.statusLog.log('APRUN', canonicalRunNo, String(run.status), String(run.status), user.username, `bank-file ${fmt} sha256=${sha256}`);
    return { filename: `${canonicalRunNo}-${fmt}.${ext}`, contentType, body, sha256 };
  }
}

function shapeRun(r: typeof apPaymentRuns.$inferSelect) {
  return {
    run_no: r.runNo, status: r.status, pay_date: r.payDate, due_cutoff: r.dueCutoff,
    bank_account_id: r.bankAccountId != null ? Number(r.bankAccountId) : null,
    total_amount: n(r.totalAmount), total_wht: n(r.totalWht), total_net: n(r.totalNet), line_count: Number(r.lineCount ?? 0),
    created_by: r.createdBy, created_at: r.createdAt, approved_by: r.approvedBy, approved_at: r.approvedAt,
    executed_by: r.executedBy, executed_at: r.executedAt, reject_reason: r.rejectReason,
    file_format: r.fileFormat, file_hash: r.fileHash, file_generated_at: r.fileGeneratedAt, remarks: r.remarks,
  };
}

interface FileDetail { seq: number; beneficiary_bank: string; beneficiary_account: string; beneficiary_name: string; amount: number; ref: string; wht: number }
interface FileCtx { runNo: string; payDate: string; debitAcct: string; debitBank?: string; debitName: string; details: FileDetail[]; total: number }

// Generic Thai bulk-transfer CSV: one H(eader), N D(etail) rows, one T(railer). The named presets reorder
// the detail columns to each bank's common bulk-upload shape; adjust to the bank's current template at
// go-live (documented as configurable in PN-02 §7(8b)). Amounts are plain 2-dp decimals; CSV fields are
// quoted only when they contain a comma/quote.
function thaiBulkCsv(preset: string, ctx: FileCtx): string {
  const q = (s: string | number) => { const v = String(s); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  const amt = (x: number) => x.toFixed(2);
  const rows: string[] = [];
  rows.push(['H', ctx.runNo, ctx.payDate, ctx.debitAcct, String(ctx.details.length), amt(ctx.total)].map(q).join(','));
  for (const d of ctx.details) {
    let cols: (string | number)[];
    switch (preset) {
      case 'scb':   // SCB Business Net bulk shape: seq, receiving bank, receiving acct, name, amount, value date, reference
        cols = ['D', d.seq, d.beneficiary_bank, d.beneficiary_account, d.beneficiary_name, amt(d.amount), ctx.payDate, d.ref]; break;
      case 'kbank': // K-Cash Connect bulk shape: seq, receiving acct, name, bank, amount, reference, value date
        cols = ['D', d.seq, d.beneficiary_account, d.beneficiary_name, d.beneficiary_bank, amt(d.amount), d.ref, ctx.payDate]; break;
      case 'bbl':   // Bualuang iBanking bulk shape: seq, bank, acct, amount, name, reference
        cols = ['D', d.seq, d.beneficiary_bank, d.beneficiary_account, amt(d.amount), d.beneficiary_name, d.ref]; break;
      default:      // generic
        cols = ['D', d.seq, d.beneficiary_bank, d.beneficiary_account, d.beneficiary_name, amt(d.amount), d.ref, amt(d.wht)]; break;
    }
    rows.push(cols.map(q).join(','));
  }
  rows.push(['T', String(ctx.details.length), amt(ctx.total)].map(q).join(','));
  return rows.join('\r\n') + '\r\n';
}

// Minimal, well-formed ISO 20022 pain.001.001.03 (CustomerCreditTransferInitiation) — one payment info
// block, one credit transfer per run line. THB, Asia/Bangkok business dating.
function pain001Xml(ctx: { runNo: string; payDate: string; debitAcct: string; debitName: string; details: FileDetail[]; total: number }): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const txs = ctx.details.map((d) => `      <CdtTrfTxInf>
        <PmtId><EndToEndId>${esc(d.ref)}</EndToEndId></PmtId>
        <Amt><InstdAmt Ccy="THB">${d.amount.toFixed(2)}</InstdAmt></Amt>
        <Cdtr><Nm>${esc(d.beneficiary_name)}</Nm></Cdtr>
        <CdtrAcct><Id><Othr><Id>${esc(d.beneficiary_account)}</Id></Othr></Id></CdtrAcct>
        <RmtInf><Ustrd>${esc(d.ref)}</Ustrd></RmtInf>
      </CdtTrfTxInf>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${esc(ctx.runNo)}</MsgId>
      <CreDtTm>${new Date().toISOString()}</CreDtTm>
      <NbOfTxs>${ctx.details.length}</NbOfTxs>
      <CtrlSum>${ctx.total.toFixed(2)}</CtrlSum>
      <InitgPty><Nm>${esc(ctx.debitName)}</Nm></InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${esc(ctx.runNo)}</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <ReqdExctnDt>${esc(ctx.payDate)}</ReqdExctnDt>
      <Dbtr><Nm>${esc(ctx.debitName)}</Nm></Dbtr>
      <DbtrAcct><Id><Othr><Id>${esc(ctx.debitAcct)}</Id></Othr></Id></DbtrAcct>
${txs}
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>
`;
}

function addDaysYmd(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
