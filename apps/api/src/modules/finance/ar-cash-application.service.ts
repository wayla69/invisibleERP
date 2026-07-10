import { Inject, Injectable, NotFoundException, BadRequestException, ForbiddenException, Optional } from '@nestjs/common';
import { sql, eq, and, desc, asc, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { arInvoices, arReceipts, arReceiptApplications, tenants, taxInvoices } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { StatusLogService } from '../../common/status-log.service';
import { LedgerService } from '../ledger/ledger.service';
import { ymd, n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

// ───────────────────────────── AR cash application (REV-20, docs/41 FIN-1) ─────────────────────────────
// One customer receipt applied across MANY invoices (partial allowed); the remainder parks ON-ACCOUNT
// (unapplied cash, GL 2220 Unapplied Customer Receipts) and is applied to invoices later. An Issued
// AR-linked credit note (ใบลดหนี้, TAX-07) can be applied as a credit line in the same worksheet —
// re-aligning the AR sub-ledger to the GL 1100 credit the note posted at approval. Controls:
//  · an application can never exceed the receipt (APPLY_EXCEEDS_RECEIPT) or an invoice's open balance
//    (OVER_APPLIED — pending applications count as committed),
//  · cross-customer application is rejected (CUSTOMER_MISMATCH),
//  · a cash application batch at/over the approval threshold parks PendingApproval until a DIFFERENT
//    user approves it (SOD_VIOLATION on self-approval — mirrors the REV-16 refund threshold),
//  · a reversal requires a reason and is audited in place (reversed flag + who/when/why); the cash
//    returns to on-account.
// GL: receipt = Dr 1000 Cash / Cr 1100 AR (applied) / Cr 2220 (on-account remainder) — the existing
// receipt semantics with the unapplied leg parked on 2220. A later application (or an approved parked
// batch) posts Dr 2220 / Cr 1100. A reversal posts Dr 1100 / Cr 2220. A credit-note application posts
// NO GL (the note's Dr 4000 + Dr 2100 / Cr 1100 already posted at its TAX-07 approval).

// Applications at/above this total require a DIFFERENT approver before invoices move (maker-checker,
// anti-lapping); below it the application applies immediately. A flat threshold for now — mirrors
// REFUND_APPROVAL_THRESHOLD (REV-16); a tenant-level override can come later.
export const CASH_APP_APPROVAL_THRESHOLD = 100000;

export interface CashAppLineDto { invoice_no: string; amount: number }
export interface CreditNoteLineDto { doc_no: string; invoice_no: string; amount: number }
export interface CashApplicationDto {
  customer_no: string | number;
  amount?: number; // cash received (0/omitted = credit-note-only worksheet)
  method?: string; ref_no?: string; remarks?: string; idempotency_key?: string;
  lines?: CashAppLineDto[];
  credit_notes?: CreditNoteLineDto[];
}
export interface ApplyOnAccountDto { receipt_ref: string; lines: CashAppLineDto[] }

const round2 = (x: number) => Math.round(x * 100) / 100;

@Injectable()
export class ArCashApplicationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly statusLog: StatusLogService,
    @Optional() private readonly ledger?: LedgerService, // absent in hand-constructed harnesses → GL skipped
  ) {}

  // Resolve a customer by tenant id (numeric) or tenants.code.
  private async resolveCustomer(customerNo: string | number) {
    const raw = String(customerNo ?? '').trim();
    if (!raw) throw new BadRequestException({ code: 'CUSTOMER_REQUIRED', message: 'customer_no is required', messageTh: 'ต้องระบุลูกค้า' });
    const pred = /^\d+$/.test(raw) ? eq(tenants.id, Number(raw)) : eq(tenants.code, raw);
    const [t] = await this.db.select().from(tenants).where(pred).limit(1);
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: `Customer ${raw} not found`, messageTh: 'ไม่พบลูกค้า' });
    return t;
  }

  // Σ committed-but-not-yet-applied (PendingApproval) amounts per invoice — counted against the open
  // balance so two pending batches can't jointly over-apply an invoice (mirrors the AP over-request guard).
  private async pendingByInvoice(invoiceNos: string[]): Promise<Map<string, number>> {
    if (!invoiceNos.length) return new Map();
    const rows = await this.db.select({ inv: arReceiptApplications.invoiceNo, v: sql<string>`coalesce(sum(${arReceiptApplications.appliedAmount}),0)` })
      .from(arReceiptApplications)
      .where(and(inArray(arReceiptApplications.invoiceNo, invoiceNos), eq(arReceiptApplications.status, 'PendingApproval')))
      .groupBy(arReceiptApplications.invoiceNo);
    return new Map(rows.map((r: any) => [String(r.inv), n(r.v)]));
  }

  // Σ pending applications drawing on a receipt's on-account cash (not yet decremented from unapplied).
  private async pendingOnReceipt(receiptNo: string): Promise<number> {
    const [r] = await this.db.select({ v: sql<string>`coalesce(sum(${arReceiptApplications.appliedAmount}),0)` })
      .from(arReceiptApplications)
      .where(and(eq(arReceiptApplications.receiptNo, receiptNo), eq(arReceiptApplications.sourceType, 'receipt'), eq(arReceiptApplications.status, 'PendingApproval')));
    return n(r?.v);
  }

  // Σ effective applications of a credit note (applied, not reversed) — the note's used-up credit.
  private async cnApplied(docNo: string): Promise<number> {
    const [r] = await this.db.select({ v: sql<string>`coalesce(sum(${arReceiptApplications.appliedAmount}),0)` })
      .from(arReceiptApplications)
      .where(and(eq(arReceiptApplications.receiptNo, docNo), eq(arReceiptApplications.sourceType, 'credit_note'), eq(arReceiptApplications.status, 'applied'), eq(arReceiptApplications.reversed, false)));
    return n(r?.v);
  }

  // Validate a set of application lines against a customer's open invoices. Returns the loaded invoice
  // rows keyed by invoice_no. Throws OVER_APPLIED / CUSTOMER_MISMATCH / NOT_FOUND / BAD_AMOUNT.
  private async validateLines(tenantId: number, lines: CashAppLineDto[]) {
    const byInv = new Map<string, { row: any; want: number }>();
    for (const l of lines) {
      const amt = round2(Number(l.amount) || 0);
      if (!(amt > 0)) throw new BadRequestException({ code: 'BAD_AMOUNT', message: `Application amount for ${l.invoice_no} must be > 0`, messageTh: 'จำนวนเงินตัดชำระต้องมากกว่าศูนย์' });
      const cur = byInv.get(l.invoice_no);
      if (cur) { cur.want = round2(cur.want + amt); continue; }
      const [inv] = await this.db.select().from(arInvoices).where(eq(arInvoices.invoiceNo, l.invoice_no)).limit(1);
      if (!inv) throw new NotFoundException({ code: 'NOT_FOUND', message: `Invoice ${l.invoice_no} not found`, messageTh: `ไม่พบใบแจ้งหนี้ ${l.invoice_no}` });
      if (Number(inv.tenantId) !== tenantId) {
        throw new BadRequestException({ code: 'CUSTOMER_MISMATCH', message: `Invoice ${l.invoice_no} belongs to another customer`, messageTh: `ใบแจ้งหนี้ ${l.invoice_no} เป็นของลูกค้ารายอื่น` });
      }
      byInv.set(l.invoice_no, { row: inv, want: amt });
    }
    const pending = await this.pendingByInvoice([...byInv.keys()]);
    for (const [no, e] of byInv) {
      const open = round2(n(e.row.amount) - n(e.row.paidAmount) - (pending.get(no) ?? 0));
      if (e.want > open + 0.001) {
        throw new BadRequestException({ code: 'OVER_APPLIED', message: `Application ${e.want} exceeds open balance ${open} on ${no} (incl. pending applications)`, messageTh: `ยอดตัดชำระเกินยอดคงค้างของ ${no} (รวมรายการที่รออนุมัติ)` });
      }
    }
    return byInv;
  }

  // Apply an amount to an invoice under a row lock; recompute paid/status from the LOCKED value.
  private async applyToInvoice(tx: any, invoiceId: number, amt: number) {
    const [locked] = await tx.select().from(arInvoices).where(eq(arInvoices.id, invoiceId)).for('update').limit(1);
    const newPaid = round2(n(locked.paidAmount) + amt);
    const status = newPaid >= n(locked.amount) ? 'Paid' : newPaid > 0 ? 'Partial' : 'Unpaid';
    await tx.update(arInvoices).set({ paidAmount: String(newPaid), status }).where(eq(arInvoices.id, invoiceId));
    return { invoice_no: locked.invoiceNo as string, paid_amount: newPaid, status, prior_status: String(locked.status ?? '') };
  }

  // ── POST /api/finance/ar/cash-application — one receipt across many invoices + on-account remainder ──
  async createCashApplication(dto: CashApplicationDto, user: JwtUser) {
    const db = this.db;
    const cust = await this.resolveCustomer(dto.customer_no);
    const tenantId = Number(cust.id);
    const amount = round2(Number(dto.amount) || 0);
    const cashLines = (dto.lines ?? []).filter((l) => l && l.invoice_no);
    const cnLines = (dto.credit_notes ?? []).filter((l) => l && l.doc_no && l.invoice_no);
    if (amount < 0) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'amount must be >= 0', messageTh: 'จำนวนเงินรับต้องไม่ติดลบ' });
    if (!(amount > 0) && !cnLines.length) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'Provide a receipt amount and/or credit-note lines', messageTh: 'ต้องมีเงินรับหรือรายการใบลดหนี้อย่างน้อยหนึ่งรายการ' });
    if (cashLines.length && !(amount > 0)) throw new BadRequestException({ code: 'APPLY_EXCEEDS_RECEIPT', message: 'Cash application lines require a receipt amount', messageTh: 'มีรายการตัดชำระแต่ไม่มีเงินรับ' });

    // Idempotency: a retried worksheet with the same key returns the original receipt/batch (no double
    // receipt, no double application).
    if (dto.idempotency_key && amount > 0) {
      const [ex] = await db.select().from(arReceipts).where(and(eq(arReceipts.tenantId, tenantId), eq(arReceipts.idempotencyKey, dto.idempotency_key))).limit(1);
      if (ex) {
        const [b] = await db.select({ batch: arReceiptApplications.batchNo }).from(arReceiptApplications).where(and(eq(arReceiptApplications.receiptNo, ex.receiptNo), eq(arReceiptApplications.sourceType, 'receipt'))).limit(1);
        return { receipt_no: ex.receiptNo, batch_no: b?.batch ?? null, amount: n(ex.amount), on_account: n(ex.unappliedAmount), idempotent: true };
      }
    }

    const cashTotal = round2(cashLines.reduce((a, l) => a + round2(Number(l.amount) || 0), 0));
    if (cashTotal > amount + 0.001) {
      throw new BadRequestException({ code: 'APPLY_EXCEEDS_RECEIPT', message: `Applications ${cashTotal} exceed the receipt amount ${amount}`, messageTh: `ยอดตัดชำระรวม (${cashTotal}) เกินจำนวนเงินรับ (${amount})` });
    }

    // Cash + CN lines on the SAME invoice draw on one open balance — validate them jointly.
    const jointLines: CashAppLineDto[] = [...cashLines, ...cnLines.map((c) => ({ invoice_no: c.invoice_no, amount: c.amount }))];
    const invMap = await this.validateLines(tenantId, jointLines);
    const invId = (no: string): number => {
      const e = invMap.get(no);
      if (!e) throw new NotFoundException({ code: 'NOT_FOUND', message: `Invoice ${no} not found`, messageTh: 'ไม่พบใบแจ้งหนี้' });
      return Number(e.row.id);
    };

    // Credit-note validation: the note must be an Issued (TAX-07-approved) CREDIT note whose source AR
    // invoice belongs to this customer, and its remaining credit must cover the line.
    const cnDocs = new Map<string, { head: any; want: number }>();
    for (const c of cnLines) {
      const amt = round2(Number(c.amount) || 0);
      const cur = cnDocs.get(c.doc_no);
      if (cur) { cur.want = round2(cur.want + amt); continue; }
      const [head] = await db.select().from(taxInvoices).where(eq(taxInvoices.docNo, c.doc_no)).limit(1);
      if (!head) throw new NotFoundException({ code: 'NOT_FOUND', message: `Credit note ${c.doc_no} not found`, messageTh: `ไม่พบใบลดหนี้ ${c.doc_no}` });
      if (head.type !== 'credit_note') throw new BadRequestException({ code: 'NOT_A_CREDIT_NOTE', message: `${c.doc_no} is not a credit note`, messageTh: `${c.doc_no} ไม่ใช่ใบลดหนี้` });
      if (head.status !== 'Issued') throw new BadRequestException({ code: 'CN_NOT_ISSUED', message: `Credit note ${c.doc_no} is ${head.status}, not Issued`, messageTh: 'ใบลดหนี้ยังไม่ผ่านการอนุมัติ/ออกใช้' });
      // Boundary (PN-01 §7 step 8e): only an AR-sourced note carries a customer linkage; a POS-sale note
      // has no AR invoice to relieve and cannot be applied here.
      if (String(head.sourceType) !== 'AR') throw new BadRequestException({ code: 'CN_NOT_AR_LINKED', message: `Credit note ${c.doc_no} is not linked to an AR invoice`, messageTh: 'ใบลดหนี้นี้ไม่ได้อ้างอิงใบแจ้งหนี้ลูกหนี้ (AR)' });
      const [srcInv] = await db.select({ tenantId: arInvoices.tenantId }).from(arInvoices).where(eq(arInvoices.invoiceNo, String(head.sourceRef))).limit(1);
      if (!srcInv || Number(srcInv.tenantId) !== tenantId) {
        throw new BadRequestException({ code: 'CUSTOMER_MISMATCH', message: `Credit note ${c.doc_no} belongs to another customer`, messageTh: `ใบลดหนี้ ${c.doc_no} เป็นของลูกค้ารายอื่น` });
      }
      cnDocs.set(c.doc_no, { head, want: amt });
    }
    for (const [docNo, e] of cnDocs) {
      const remaining = round2(n(e.head.grandTotal) - (await this.cnApplied(docNo)));
      if (e.want > remaining + 0.001) {
        throw new BadRequestException({ code: 'CN_OVER_APPLIED', message: `Credit note ${docNo} has only ${remaining} remaining`, messageTh: `ใบลดหนี้ ${docNo} มีวงเงินคงเหลือ ${remaining}` });
      }
    }

    // Threshold maker-checker (mirrors REV-16): a cash application at/over the threshold parks — the cash
    // banks in full on-account (Dr 1000 / Cr 2220) and NO invoice moves until a different user approves.
    const park = cashTotal >= CASH_APP_APPROVAL_THRESHOLD;
    const batchNo = await this.docNo.nextDaily('APL');
    const receiptNo = amount > 0 ? await this.docNo.nextDaily('RCP') : null;
    const today = ymd();
    const applications: any[] = [];
    let lineSeq = 0;
    await db.transaction(async (tx: any) => {
      if (receiptNo) {
        await tx.insert(arReceipts).values({
          receiptNo, receiptDate: today, tenantId, invoiceNo: null, amount: String(amount),
          unappliedAmount: String(round2(amount - (park ? 0 : cashTotal))),
          method: dto.method ?? 'Transfer', refNo: dto.ref_no ?? null, remarks: dto.remarks ?? null,
          idempotencyKey: dto.idempotency_key ?? null, createdBy: user.username,
        });
      }
      for (const l of cashLines) {
        lineSeq++;
        const amt = round2(Number(l.amount));
        const applicationNo = `${batchNo}-L${lineSeq}`;
        await tx.insert(arReceiptApplications).values({
          applicationNo, batchNo, tenantId, sourceType: 'receipt', receiptNo: receiptNo!, invoiceNo: l.invoice_no,
          appliedAmount: String(amt), status: park ? 'PendingApproval' : 'applied', appliedBy: user.username,
        });
        let applied: any = null;
        if (!park) applied = await this.applyToInvoice(tx, invId(l.invoice_no), amt);
        applications.push({ application_no: applicationNo, source: 'receipt', invoice_no: l.invoice_no, amount: amt, status: park ? 'PendingApproval' : 'applied', invoice_status: applied?.status ?? null });
      }
      for (const c of cnLines) {
        lineSeq++;
        const amt = round2(Number(c.amount));
        const applicationNo = `${batchNo}-L${lineSeq}`;
        await tx.insert(arReceiptApplications).values({
          applicationNo, batchNo, tenantId, sourceType: 'credit_note', receiptNo: c.doc_no, invoiceNo: c.invoice_no,
          appliedAmount: String(amt), status: 'applied', appliedBy: user.username,
        });
        const applied = await this.applyToInvoice(tx, invId(c.invoice_no), amt);
        applications.push({ application_no: applicationNo, source: 'credit_note', doc_no: c.doc_no, invoice_no: c.invoice_no, amount: amt, status: 'applied', invoice_status: applied.status });
      }
    });

    // GL — existing receipt semantics with the unapplied leg on 2220: Dr 1000 cash in full; Cr 1100 per
    // the applied total; Cr 2220 for the on-account remainder (a parked batch banks fully on 2220 and the
    // 1100 relief posts at approval). Credit-note lines post NOTHING (their GL landed at CN approval).
    const appliedNow = park ? 0 : cashTotal;
    const onAccount = round2(amount - appliedNow);
    if (this.ledger && receiptNo && amount > 0 && !(await this.ledger.alreadyPosted('RCP', receiptNo, tenantId))) {
      const lines: any[] = [{ account_code: '1000', debit: amount }];
      if (appliedNow > 0) lines.push({ account_code: '1100', credit: appliedNow });
      if (onAccount > 0) lines.push({ account_code: '2220', credit: onAccount, memo: 'On-account (unapplied) cash' });
      await this.ledger.postEntry({
        date: today, source: 'RCP', sourceRef: receiptNo, tenantId, viaSubledger: true,
        memo: `Receipt ${receiptNo} (cash application ${batchNo})`, createdBy: user.username, lines,
      });
    }
    await this.statusLog.log('APL', batchNo, '', park ? 'PendingApproval' : 'Applied', user.username, `Cash application ${receiptNo ?? '(credit notes only)'} — applied ${appliedNow}, on-account ${onAccount}, CN ${round2(cnLines.reduce((a, c) => a + round2(Number(c.amount) || 0), 0))}`);
    return {
      batch_no: batchNo, receipt_no: receiptNo, customer_tenant_id: tenantId, amount,
      applied_total: appliedNow, credit_applied: round2(cnLines.reduce((a, c) => a + round2(Number(c.amount) || 0), 0)),
      on_account: onAccount, status: park ? 'PendingApproval' : 'Applied', pending: park,
      approval_threshold: CASH_APP_APPROVAL_THRESHOLD, applications,
    };
  }

  // ── POST /api/finance/ar/apply-on-account — apply parked on-account cash to invoices later ──
  async applyOnAccount(dto: ApplyOnAccountDto, user: JwtUser) {
    const db = this.db;
    const [rc] = await db.select().from(arReceipts).where(eq(arReceipts.receiptNo, dto.receipt_ref)).limit(1);
    if (!rc) throw new NotFoundException({ code: 'NOT_FOUND', message: `Receipt ${dto.receipt_ref} not found`, messageTh: 'ไม่พบใบสำคัญรับเงิน' });
    const tenantId = Number(rc.tenantId);
    const lines = (dto.lines ?? []).filter((l) => l && l.invoice_no);
    if (!lines.length) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'No application lines', messageTh: 'ไม่มีรายการตัดชำระ' });
    const total = round2(lines.reduce((a, l) => a + round2(Number(l.amount) || 0), 0));
    const available = round2(n(rc.unappliedAmount) - (await this.pendingOnReceipt(rc.receiptNo)));
    if (total > available + 0.001) {
      throw new BadRequestException({ code: 'INSUFFICIENT_UNAPPLIED', message: `Applications ${total} exceed the receipt's available on-account cash ${available} (incl. pending)`, messageTh: `ยอดตัดชำระเกินเงินรับรอตัดชำระคงเหลือ (${available} รวมรายการรออนุมัติ)` });
    }
    const invMap = await this.validateLines(tenantId, lines);
    const invId = (no: string): number => {
      const e = invMap.get(no);
      if (!e) throw new NotFoundException({ code: 'NOT_FOUND', message: `Invoice ${no} not found`, messageTh: 'ไม่พบใบแจ้งหนี้' });
      return Number(e.row.id);
    };

    const park = total >= CASH_APP_APPROVAL_THRESHOLD;
    const batchNo = await this.docNo.nextDaily('APL');
    const applications: any[] = [];
    let lineSeq = 0;
    await db.transaction(async (tx: any) => {
      if (!park) {
        const [lockedRc] = await tx.select().from(arReceipts).where(eq(arReceipts.id, rc.id)).for('update').limit(1);
        await tx.update(arReceipts).set({ unappliedAmount: String(round2(n(lockedRc.unappliedAmount) - total)) }).where(eq(arReceipts.id, rc.id));
      }
      for (const l of lines) {
        lineSeq++;
        const amt = round2(Number(l.amount));
        const applicationNo = `${batchNo}-L${lineSeq}`;
        await tx.insert(arReceiptApplications).values({
          applicationNo, batchNo, tenantId, sourceType: 'receipt', receiptNo: rc.receiptNo, invoiceNo: l.invoice_no,
          appliedAmount: String(amt), status: park ? 'PendingApproval' : 'applied', appliedBy: user.username,
        });
        let applied: any = null;
        if (!park) applied = await this.applyToInvoice(tx, invId(l.invoice_no), amt);
        applications.push({ application_no: applicationNo, invoice_no: l.invoice_no, amount: amt, status: park ? 'PendingApproval' : 'applied', invoice_status: applied?.status ?? null });
      }
    });
    // GL — release the on-account liability into the AR relief: Dr 2220 / Cr 1100 (parked batches post at approval).
    if (!park && this.ledger && total > 0 && !(await this.ledger.alreadyPosted('AR-APPLY', batchNo, tenantId))) {
      await this.ledger.postEntry({
        date: ymd(), source: 'AR-APPLY', sourceRef: batchNo, tenantId, viaSubledger: true,
        memo: `Apply on-account ${rc.receiptNo} (${batchNo})`, createdBy: user.username,
        lines: [{ account_code: '2220', debit: total }, { account_code: '1100', credit: total }],
      });
    }
    await this.statusLog.log('APL', batchNo, '', park ? 'PendingApproval' : 'Applied', user.username, `Apply on-account ${rc.receiptNo} — ${total}`);
    return { batch_no: batchNo, receipt_no: rc.receiptNo, customer_tenant_id: tenantId, applied_total: park ? 0 : total, requested_total: total, status: park ? 'PendingApproval' : 'Applied', pending: park, approval_threshold: CASH_APP_APPROVAL_THRESHOLD, applications };
  }

  // ── POST /api/finance/ar/cash-application/:batchNo/approve — checker applies a parked batch (SoD) ──
  async approveBatch(batchNo: string, approver: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(arReceiptApplications).where(and(eq(arReceiptApplications.batchNo, batchNo), eq(arReceiptApplications.status, 'PendingApproval')));
    if (!rows.length) throw new BadRequestException({ code: 'NOT_PENDING', message: `No pending applications in batch ${batchNo}`, messageTh: 'ไม่มีรายการรออนุมัติในชุดนี้' });
    if (rows.some((r: any) => r.appliedBy && r.appliedBy === approver.username)) {
      throw new ForbiddenException({ code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot approve a cash application you posted', messageTh: 'ผู้บันทึกตัดชำระอนุมัติรายการของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    }
    const first = rows[0]!;
    const tenantId = first.tenantId != null ? Number(first.tenantId) : null;
    const total = round2(rows.reduce((a: number, r: any) => a + n(r.appliedAmount), 0));
    const applications: any[] = [];
    await db.transaction(async (tx: any) => {
      // Decrement each source receipt's on-account cash under a row lock (a batch has ONE receipt today,
      // but group defensively).
      const byReceipt = new Map<string, number>();
      for (const r of rows) byReceipt.set(String(r.receiptNo), round2((byReceipt.get(String(r.receiptNo)) ?? 0) + n(r.appliedAmount)));
      for (const [rcNo, amt] of byReceipt) {
        const [lockedRc] = await tx.select().from(arReceipts).where(eq(arReceipts.receiptNo, rcNo)).for('update').limit(1);
        if (!lockedRc) throw new NotFoundException({ code: 'NOT_FOUND', message: `Receipt ${rcNo} not found`, messageTh: 'ไม่พบใบสำคัญรับเงิน' });
        const newUnapplied = round2(n(lockedRc.unappliedAmount) - amt);
        if (newUnapplied < -0.001) throw new BadRequestException({ code: 'INSUFFICIENT_UNAPPLIED', message: `Receipt ${rcNo} no longer has ${amt} on-account`, messageTh: 'เงินรับรอตัดชำระคงเหลือไม่พอ' });
        await tx.update(arReceipts).set({ unappliedAmount: String(newUnapplied) }).where(eq(arReceipts.id, lockedRc.id));
      }
      for (const r of rows) {
        const [inv] = await tx.select({ id: arInvoices.id }).from(arInvoices).where(eq(arInvoices.invoiceNo, r.invoiceNo)).limit(1);
        if (!inv) throw new NotFoundException({ code: 'NOT_FOUND', message: `Invoice ${r.invoiceNo} not found`, messageTh: 'ไม่พบใบแจ้งหนี้' });
        const applied = await this.applyToInvoice(tx, Number(inv.id), n(r.appliedAmount));
        await tx.update(arReceiptApplications).set({ status: 'applied', approvedBy: approver.username, approvedAt: new Date() }).where(eq(arReceiptApplications.id, r.id));
        applications.push({ application_no: r.applicationNo, invoice_no: r.invoiceNo, amount: n(r.appliedAmount), invoice_status: applied.status });
      }
    });
    // GL — the deferred AR relief: Dr 2220 / Cr 1100 for the batch total (idempotent per batch).
    if (this.ledger && total > 0 && !(await this.ledger.alreadyPosted('AR-APPLY', batchNo, tenantId))) {
      await this.ledger.postEntry({
        date: ymd(), source: 'AR-APPLY', sourceRef: batchNo, tenantId, viaSubledger: true,
        memo: `Approved cash application ${batchNo}`, createdBy: approver.username,
        lines: [{ account_code: '2220', debit: total }, { account_code: '1100', credit: total }],
      });
    }
    await this.statusLog.log('APL', batchNo, 'PendingApproval', 'Applied', approver.username);
    return { batch_no: batchNo, status: 'Applied', approved_by: approver.username, requested_by: first.appliedBy ?? null, applied_total: total, applications };
  }

  // ── POST /api/finance/ar/cash-application/:batchNo/reject — checker declines; cash stays on-account ──
  async rejectBatch(batchNo: string, approver: JwtUser, reason?: string) {
    const db = this.db;
    const rows = await db.select().from(arReceiptApplications).where(and(eq(arReceiptApplications.batchNo, batchNo), eq(arReceiptApplications.status, 'PendingApproval')));
    if (!rows.length) throw new BadRequestException({ code: 'NOT_PENDING', message: `No pending applications in batch ${batchNo}`, messageTh: 'ไม่มีรายการรออนุมัติในชุดนี้' });
    await db.update(arReceiptApplications).set({ status: 'Rejected', approvedBy: approver.username, approvedAt: new Date(), rejectReason: reason ?? null })
      .where(and(eq(arReceiptApplications.batchNo, batchNo), eq(arReceiptApplications.status, 'PendingApproval')));
    await this.statusLog.log('APL', batchNo, 'PendingApproval', 'Rejected', approver.username, reason);
    return { batch_no: batchNo, status: 'Rejected', rejected_by: approver.username, lines: rows.length };
  }

  // ── POST /api/finance/ar/cash-application/:applicationNo/reverse — audited un-apply (reason required) ──
  // A cash line's amount returns to the receipt's on-account balance (Dr 1100 / Cr 2220); a credit-note
  // line simply reopens the invoice (the note's own GL stands — it still reduces AR until re-applied).
  async reverseApplication(applicationNo: string, reason: string | undefined, user: JwtUser) {
    const db = this.db;
    if (!reason || !reason.trim()) throw new BadRequestException({ code: 'REASON_REQUIRED', message: 'A reversal reason is required', messageTh: 'ต้องระบุเหตุผลการยกเลิกตัดชำระ' });
    const [row] = await db.select().from(arReceiptApplications).where(eq(arReceiptApplications.applicationNo, applicationNo)).limit(1);
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: `Application ${applicationNo} not found`, messageTh: 'ไม่พบรายการตัดชำระ' });
    if (row.reversed) throw new BadRequestException({ code: 'ALREADY_REVERSED', message: `Application ${applicationNo} is already reversed`, messageTh: 'รายการนี้ถูกยกเลิกแล้ว' });
    if (row.status !== 'applied') throw new BadRequestException({ code: 'NOT_APPLIED', message: `Application ${applicationNo} is ${row.status}, not applied`, messageTh: 'รายการนี้ยังไม่ถูกตัดชำระ' });
    const amt = n(row.appliedAmount);
    const tenantId = row.tenantId != null ? Number(row.tenantId) : null;
    let invoiceStatus = '';
    await db.transaction(async (tx: any) => {
      const [inv] = await tx.select().from(arInvoices).where(eq(arInvoices.invoiceNo, row.invoiceNo)).for('update').limit(1);
      if (!inv) throw new NotFoundException({ code: 'NOT_FOUND', message: `Invoice ${row.invoiceNo} not found`, messageTh: 'ไม่พบใบแจ้งหนี้' });
      const newPaid = round2(n(inv.paidAmount) - amt);
      invoiceStatus = newPaid >= n(inv.amount) ? 'Paid' : newPaid > 0 ? 'Partial' : 'Unpaid';
      await tx.update(arInvoices).set({ paidAmount: String(newPaid), status: invoiceStatus }).where(eq(arInvoices.id, inv.id));
      if (row.sourceType === 'receipt') {
        const [rc] = await tx.select().from(arReceipts).where(eq(arReceipts.receiptNo, row.receiptNo)).for('update').limit(1);
        if (rc) await tx.update(arReceipts).set({ unappliedAmount: String(round2(n(rc.unappliedAmount) + amt)) }).where(eq(arReceipts.id, rc.id));
      }
      await tx.update(arReceiptApplications).set({ reversed: true, reversedBy: user.username, reversedAt: new Date(), reverseReason: reason.trim() }).where(eq(arReceiptApplications.id, row.id));
    });
    if (row.sourceType === 'receipt' && this.ledger && amt > 0 && !(await this.ledger.alreadyPosted('AR-APPLY-REV', applicationNo, tenantId))) {
      await this.ledger.postEntry({
        date: ymd(), source: 'AR-APPLY-REV', sourceRef: applicationNo, tenantId, viaSubledger: true,
        memo: `Reverse cash application ${applicationNo}: ${reason.trim()}`, createdBy: user.username,
        lines: [{ account_code: '1100', debit: amt }, { account_code: '2220', credit: amt }],
      });
    }
    await this.statusLog.log('APL', applicationNo, 'applied', 'Reversed', user.username, reason.trim());
    return { application_no: applicationNo, batch_no: row.batchNo, invoice_no: row.invoiceNo, source: row.sourceType, amount: amt, invoice_status: invoiceStatus, reversed: true, reversed_by: user.username, reason: reason.trim() };
  }

  // ── GET /api/finance/ar/cash-application — the application register (worksheet history + pending queue) ──
  async listApplications(opts: { status?: string; invoice_no?: string; receipt_no?: string; limit?: number } = {}) {
    const conds: any[] = [];
    if (opts.status) conds.push(eq(arReceiptApplications.status, opts.status));
    if (opts.invoice_no) conds.push(eq(arReceiptApplications.invoiceNo, opts.invoice_no));
    if (opts.receipt_no) conds.push(eq(arReceiptApplications.receiptNo, opts.receipt_no));
    const rows = await this.db.select().from(arReceiptApplications).where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(arReceiptApplications.id)).limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
    return {
      applications: rows.map((r: any) => ({
        application_no: r.applicationNo, batch_no: r.batchNo, tenant_id: r.tenantId, source: r.sourceType,
        receipt_no: r.receiptNo, invoice_no: r.invoiceNo, amount: n(r.appliedAmount), status: r.status,
        applied_by: r.appliedBy, applied_at: r.appliedAt, approved_by: r.approvedBy,
        reversed: r.reversed === true, reversed_by: r.reversedBy, reverse_reason: r.reverseReason,
      })),
      count: rows.length,
    };
  }

  // ── GET /api/finance/ar/open-items?customer_no= — the cash-application worksheet feed ──
  // Open invoices (with pending-committed amounts), unapplied (on-account) receipts, and applicable
  // AR-linked credit notes — plus the customer's net position.
  async openItems(customerNo: string | number) {
    const db = this.db;
    const cust = await this.resolveCustomer(customerNo);
    const tenantId = Number(cust.id);
    const today = ymd();
    const invRows = await db.select().from(arInvoices).where(and(eq(arInvoices.tenantId, tenantId), sql`${arInvoices.status}::text <> 'Paid'`)).orderBy(asc(arInvoices.dueDate), asc(arInvoices.invoiceNo));
    const pending = await this.pendingByInvoice(invRows.map((r: any) => String(r.invoiceNo)));
    const invoices = invRows
      .map((r: any) => {
        const outstanding = round2(n(r.amount) - n(r.paidAmount));
        const pend = pending.get(String(r.invoiceNo)) ?? 0;
        const overdue = r.dueDate ? Math.max(0, Math.round((Date.parse(today) - Date.parse(String(r.dueDate))) / 86400000)) : 0;
        return { invoice_no: r.invoiceNo, invoice_date: r.invoiceDate, due_date: r.dueDate, amount: n(r.amount), paid_amount: n(r.paidAmount), outstanding, pending_applied: round2(pend), available: round2(outstanding - pend), days_overdue: overdue };
      })
      .filter((r: any) => r.outstanding > 0.0001);
    const rcRows = await db.select().from(arReceipts).where(and(eq(arReceipts.tenantId, tenantId), sql`coalesce(${arReceipts.unappliedAmount},0) > 0`)).orderBy(asc(arReceipts.receiptDate), asc(arReceipts.receiptNo));
    const unapplied_receipts: any[] = [];
    for (const r of rcRows) {
      const pend = await this.pendingOnReceipt(String(r.receiptNo));
      unapplied_receipts.push({ receipt_no: r.receiptNo, receipt_date: r.receiptDate, amount: n(r.amount), unapplied: n(r.unappliedAmount), pending_applied: round2(pend), available: round2(n(r.unappliedAmount) - pend), method: r.method ?? 'Transfer' });
    }
    // Issued AR-linked credit notes of this customer with remaining credit.
    const cnHeads = await db.select().from(taxInvoices).where(and(eq(taxInvoices.type, 'credit_note' as typeof taxInvoices.$inferSelect.type), eq(taxInvoices.status, 'Issued' as typeof taxInvoices.$inferSelect.status), eq(taxInvoices.sourceType, 'AR' as typeof taxInvoices.$inferSelect.sourceType)));
    const credit_notes: any[] = [];
    for (const h of cnHeads) {
      const [srcInv] = await db.select({ tenantId: arInvoices.tenantId }).from(arInvoices).where(eq(arInvoices.invoiceNo, String(h.sourceRef))).limit(1);
      if (!srcInv || Number(srcInv.tenantId) !== tenantId) continue;
      const applied = await this.cnApplied(String(h.docNo));
      const remaining = round2(n(h.grandTotal) - applied);
      if (remaining > 0.0001) credit_notes.push({ doc_no: h.docNo, issue_date: h.issueDate, original_doc_no: h.originalDocNo, source_invoice_no: h.sourceRef, grand_total: n(h.grandTotal), applied: round2(applied), remaining, reason: h.reason ?? null });
    }
    const open_total = round2(invoices.reduce((a: number, r: any) => a + r.outstanding, 0));
    const on_account = round2(unapplied_receipts.reduce((a, r) => a + r.unapplied, 0));
    const cn_total = round2(credit_notes.reduce((a, r) => a + r.remaining, 0));
    return {
      customer: { tenant_id: tenantId, code: cust.code, name: cust.name ?? cust.code },
      invoices, unapplied_receipts, credit_notes,
      totals: { open_invoices: open_total, on_account, credit_notes: cn_total, net_position: round2(open_total - on_account - cn_total) },
      as_of: today,
    };
  }

  // ── GET /api/finance/ar/cash-application/suggest — deterministic auto-suggest ──
  // 1) an EXACT single-invoice match on the amount wins (earliest due date on ties);
  // 2) otherwise greedy oldest-due-first allocation, partial on the last line; any remainder is on-account.
  async suggest(params: { customer_no?: string | number; amount?: number; receipt_ref?: string }) {
    let tenantKey: string | number | undefined = params.customer_no;
    let amount = round2(Number(params.amount) || 0);
    let receipt: any = null;
    if (params.receipt_ref) {
      const [rc] = await this.db.select().from(arReceipts).where(eq(arReceipts.receiptNo, params.receipt_ref)).limit(1);
      if (!rc) throw new NotFoundException({ code: 'NOT_FOUND', message: `Receipt ${params.receipt_ref} not found`, messageTh: 'ไม่พบใบสำคัญรับเงิน' });
      receipt = rc;
      tenantKey = Number(rc.tenantId);
      if (!(amount > 0)) amount = round2(n(rc.unappliedAmount) - (await this.pendingOnReceipt(String(rc.receiptNo))));
    }
    if (tenantKey == null) throw new BadRequestException({ code: 'CUSTOMER_REQUIRED', message: 'customer_no or receipt_ref is required', messageTh: 'ต้องระบุลูกค้าหรือใบสำคัญรับเงิน' });
    if (!(amount > 0)) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'amount must be > 0', messageTh: 'จำนวนเงินต้องมากกว่าศูนย์' });
    const items = await this.openItems(tenantKey);
    const open = items.invoices.filter((r: any) => r.available > 0.0001); // already due-date ascending
    // exact single-invoice match first (deterministic: the earliest-due exact match)
    const exact = open.find((r: any) => Math.abs(r.available - amount) < 0.005);
    let lines: { invoice_no: string; due_date: string | null; outstanding: number; apply: number }[];
    if (exact) {
      lines = [{ invoice_no: exact.invoice_no, due_date: exact.due_date, outstanding: exact.available, apply: amount }];
    } else {
      lines = [];
      let left = amount;
      for (const r of open) {
        if (left <= 0.0001) break;
        const apply = round2(Math.min(left, r.available));
        lines.push({ invoice_no: r.invoice_no, due_date: r.due_date, outstanding: r.available, apply });
        left = round2(left - apply);
      }
    }
    const appliedTotal = round2(lines.reduce((a, l) => a + l.apply, 0));
    return {
      customer: items.customer, receipt_no: receipt?.receiptNo ?? null, amount,
      exact_match: !!exact, lines, applied_total: appliedTotal, on_account_remainder: round2(amount - appliedTotal),
    };
  }
}
