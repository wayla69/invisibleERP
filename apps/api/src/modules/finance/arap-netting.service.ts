import { Inject, Injectable, NotFoundException, BadRequestException, Optional } from '@nestjs/common';
import { sql, eq, and, or, asc, desc } from 'drizzle-orm';
import { assertMakerChecker } from '../../common/control-profile';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { arInvoices, apTransactions, tenants, vendors, nettingAgreements, nettingSettlements, nettingSettlementLines } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { StatusLogService } from '../../common/status-log.service';
import { LedgerService } from '../ledger/ledger.service';
import { ymd, n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

// ───────────────────────── AR/AP netting & contra settlement (docs/41 FIN-8, REV-23) ─────────────────────────
// A counterparty is often BOTH a customer (AR) and a vendor (AP). Netting offsets its open AR against its open
// AP with a single CONTRA JE (Dr 2000 AP / Cr 1100 AR) that clears both sub-ledgers up to the netted amount,
// leaving the residual open. Controls:
//  · a NETTING AGREEMENT must exist + be enabled for the counterparty (NETTING_NOT_AGREED / NETTING_DISABLED);
//  · a per-counterparty THRESHOLD caps any one settlement's net amount (NETTING_EXCEEDS_THRESHOLD);
//  · every settlement is MAKER-CHECKED — proposed PendingApproval (no GL, no sub-ledger movement) and applied
//    only when a DIFFERENT user approves (SOD_VIOLATION on self-approval, binds even Admin), with a MANDATORY
//    reason (REASON_REQUIRED) — mirrors the REV-21 cash-application maker-checker;
//  · nothing to net (no open AR or no open AP) is rejected (NOTHING_TO_NET).
// GL: on approval only — Dr 2000 (AP control) / Cr 1100 (AR control) for net_amount (viaSubledger so the
// control accounts are respected). AR is applied oldest-due-first across open invoices, AP oldest-due-first
// across open bills — both absorb exactly net_amount, so the JE balances and the sub-ledgers stay tied to GL.
// The netting statement (header + lines) records exactly what was offset.

export interface NettingAgreementDto { customer_no: string | number; vendor: string | number; enabled?: boolean; threshold?: number | null; notes?: string; currency?: string }
export interface ProposeNettingDto { customer_no: string | number; vendor: string | number; amount?: number; reason: string }

const round2 = (x: number) => Math.round(x * 100) / 100;

@Injectable()
export class ArApNettingService {
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

  // Resolve a vendor by id (numeric), vendor_code, or name.
  private async resolveVendor(vendor: string | number) {
    const raw = String(vendor ?? '').trim();
    if (!raw) throw new BadRequestException({ code: 'VENDOR_REQUIRED', message: 'vendor is required', messageTh: 'ต้องระบุเจ้าหนี้' });
    const pred = /^\d+$/.test(raw) ? eq(vendors.id, Number(raw)) : or(eq(vendors.vendorCode, raw), eq(vendors.name, raw));
    const [v] = await this.db.select().from(vendors).where(pred).limit(1);
    if (!v) throw new NotFoundException({ code: 'NOT_FOUND', message: `Vendor ${raw} not found`, messageTh: 'ไม่พบเจ้าหนี้' });
    return v;
  }

  // Load the netting agreement for a (customer, vendor) counterparty under the caller's company. Missing →
  // NETTING_NOT_AGREED (netting requires an authorising agreement).
  private async loadAgreement(tenantId: number | null, customerTenantId: number, vendorId: number, opts?: { require?: boolean }) {
    const conds = [eq(nettingAgreements.customerTenantId, customerTenantId), eq(nettingAgreements.vendorId, vendorId)];
    if (tenantId != null) conds.push(eq(nettingAgreements.tenantId, tenantId));
    const [a] = await this.db.select().from(nettingAgreements).where(and(...conds)).orderBy(desc(nettingAgreements.id)).limit(1);
    if (!a && opts?.require) throw new BadRequestException({ code: 'NETTING_NOT_AGREED', message: 'No netting agreement for this counterparty', messageTh: 'ยังไม่มีข้อตกลงหักกลบลบหนี้สำหรับคู่ค้ารายนี้' });
    return a ?? null;
  }

  // Open AR (customer's unpaid invoices) + open AP (our unpaid bills to the vendor), oldest-due-first.
  private async computeOpen(customerTenantId: number, vendorId: number, vendorName: string | null, ourTenantId: number | null) {
    const invRows = await this.db.select().from(arInvoices)
      .where(and(eq(arInvoices.tenantId, customerTenantId), sql`${arInvoices.status}::text <> 'Paid'`))
      .orderBy(asc(arInvoices.dueDate), asc(arInvoices.invoiceNo));
    const arRows = invRows
      .map((r: any) => ({ doc_no: r.invoiceNo as string, id: Number(r.id), due_date: r.dueDate, open: round2(n(r.amount) - n(r.paidAmount)) }))
      .filter((r) => r.open > 0.0001);
    const vendorPred = or(eq(apTransactions.vendorId, vendorId), vendorName ? eq(apTransactions.vendorName, vendorName) : undefined);
    const apConds: any[] = [sql`${apTransactions.status}::text <> 'Paid'`, vendorPred];
    if (ourTenantId != null) apConds.push(eq(apTransactions.tenantId, ourTenantId));
    const billRows = await this.db.select().from(apTransactions)
      .where(and(...apConds))
      .orderBy(asc(apTransactions.dueDate), asc(apTransactions.txnNo));
    const apRows = billRows
      .map((r: any) => ({ doc_no: r.txnNo as string, id: Number(r.id), due_date: r.dueDate, open: round2(n(r.amount) - n(r.paidAmount)) }))
      .filter((r) => r.open > 0.0001);
    const arOpen = round2(arRows.reduce((a, r) => a + r.open, 0));
    const apOpen = round2(apRows.reduce((a, r) => a + r.open, 0));
    return { arRows, apRows, arOpen, apOpen };
  }

  // Greedy oldest-first allocation of `amount` across a set of open rows (partial on the last line).
  private allocate(rows: { doc_no: string; id: number; open: number }[], amount: number) {
    const lines: { doc_no: string; id: number; open: number; apply: number }[] = [];
    let left = round2(amount);
    for (const r of rows) {
      if (left <= 0.0001) break;
      const apply = round2(Math.min(left, r.open));
      lines.push({ ...r, apply });
      left = round2(left - apply);
    }
    return lines;
  }

  // ── POST /api/finance/netting/agreements — upsert the counterparty netting agreement (maker) ──
  async upsertAgreement(dto: NettingAgreementDto, user: JwtUser) {
    const cust = await this.resolveCustomer(dto.customer_no);
    const vend = await this.resolveVendor(dto.vendor);
    const tenantId = user.tenantId ?? null;
    const threshold = dto.threshold == null ? null : round2(Number(dto.threshold));
    if (threshold != null && !(threshold >= 0)) throw new BadRequestException({ code: 'BAD_THRESHOLD', message: 'threshold must be >= 0', messageTh: 'เพดานต้องไม่ติดลบ' });
    const existing = await this.loadAgreement(tenantId, Number(cust.id), Number(vend.id));
    const enabled = dto.enabled ?? existing?.nettingEnabled ?? true;
    if (existing) {
      await this.db.update(nettingAgreements).set({
        vendorName: vend.name, counterpartyName: cust.name ?? cust.code, currency: dto.currency ?? existing.currency ?? 'THB',
        nettingEnabled: enabled, threshold: threshold != null ? String(threshold) : (dto.threshold === null ? null : existing.threshold),
        notes: dto.notes ?? existing.notes, updatedBy: user.username, updatedAt: new Date(),
      }).where(eq(nettingAgreements.id, existing.id));
      return { agreement_id: Number(existing.id), customer_tenant_id: Number(cust.id), vendor_id: Number(vend.id), enabled, threshold, updated: true };
    }
    const row = (await this.db.insert(nettingAgreements).values({
      tenantId, customerTenantId: Number(cust.id), vendorId: Number(vend.id), vendorName: vend.name,
      counterpartyName: cust.name ?? cust.code, currency: dto.currency ?? 'THB', nettingEnabled: enabled,
      threshold: threshold != null ? String(threshold) : null, notes: dto.notes ?? null, createdBy: user.username,
    }).returning({ id: nettingAgreements.id }))[0]!;
    return { agreement_id: Number(row.id), customer_tenant_id: Number(cust.id), vendor_id: Number(vend.id), enabled, threshold, updated: false };
  }

  async listAgreements(user: JwtUser) {
    const conds: any[] = [];
    if (user.tenantId != null) conds.push(eq(nettingAgreements.tenantId, Number(user.tenantId)));
    const rows = await this.db.select().from(nettingAgreements).where(conds.length ? and(...conds) : undefined).orderBy(desc(nettingAgreements.id)).limit(200);
    return {
      agreements: rows.map((r: any) => ({
        agreement_id: Number(r.id), customer_tenant_id: Number(r.customerTenantId), vendor_id: Number(r.vendorId),
        vendor_name: r.vendorName, counterparty_name: r.counterpartyName, currency: r.currency,
        enabled: r.nettingEnabled === true, threshold: r.threshold != null ? n(r.threshold) : null, notes: r.notes,
      })),
      count: rows.length,
    };
  }

  // ── GET /api/finance/netting/preview — open AR/AP positions + the proposed net for a counterparty ──
  async preview(customerNo: string | number, vendor: string | number, user: JwtUser) {
    const cust = await this.resolveCustomer(customerNo);
    const vend = await this.resolveVendor(vendor);
    const agreement = await this.loadAgreement(user.tenantId ?? null, Number(cust.id), Number(vend.id));
    const { arRows, apRows, arOpen, apOpen } = await this.computeOpen(Number(cust.id), Number(vend.id), vend.name, user.tenantId ?? null);
    const threshold = agreement?.threshold != null ? n(agreement.threshold) : null;
    let net = round2(Math.min(arOpen, apOpen));
    if (threshold != null) net = round2(Math.min(net, threshold));
    return {
      counterparty: { customer_tenant_id: Number(cust.id), customer_code: cust.code, vendor_id: Number(vend.id), vendor_name: vend.name },
      agreement: agreement ? { agreement_id: Number(agreement.id), enabled: agreement.nettingEnabled === true, threshold } : null,
      ar: { open_total: arOpen, invoices: arRows.map((r) => ({ invoice_no: r.doc_no, due_date: r.due_date, open: r.open })) },
      ap: { open_total: apOpen, bills: apRows.map((r) => ({ txn_no: r.doc_no, due_date: r.due_date, open: r.open })) },
      proposed_net: net, residual_ar: round2(arOpen - net), residual_ap: round2(apOpen - net), as_of: ymd(),
    };
  }

  // ── POST /api/finance/netting/settlements — propose a contra settlement (maker; no GL/sub-ledger yet) ──
  async propose(dto: ProposeNettingDto, user: JwtUser) {
    if (!dto.reason || !dto.reason.trim()) throw new BadRequestException({ code: 'REASON_REQUIRED', message: 'A netting reason is required', messageTh: 'ต้องระบุเหตุผลการหักกลบลบหนี้' });
    const cust = await this.resolveCustomer(dto.customer_no);
    const vend = await this.resolveVendor(dto.vendor);
    const tenantId = user.tenantId ?? null;
    const agreement = await this.loadAgreement(tenantId, Number(cust.id), Number(vend.id), { require: true });
    if (agreement!.nettingEnabled !== true) throw new BadRequestException({ code: 'NETTING_DISABLED', message: 'Netting is disabled for this counterparty', messageTh: 'ปิดการหักกลบลบหนี้สำหรับคู่ค้ารายนี้' });
    const { arRows, apRows, arOpen, apOpen } = await this.computeOpen(Number(cust.id), Number(vend.id), vend.name, tenantId);
    if (!(arOpen > 0) || !(apOpen > 0)) throw new BadRequestException({ code: 'NOTHING_TO_NET', message: `Nothing to net (open AR ${arOpen}, open AP ${apOpen})`, messageTh: 'ไม่มียอดให้หักกลบ (ต้องมีทั้งลูกหนี้และเจ้าหนี้คงค้าง)' });
    let net = round2(Math.min(arOpen, apOpen));
    if (dto.amount != null) {
      const req = round2(Number(dto.amount));
      if (!(req > 0)) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'amount must be > 0', messageTh: 'จำนวนเงินต้องมากกว่าศูนย์' });
      net = round2(Math.min(net, req));
    }
    const threshold = agreement!.threshold != null ? n(agreement!.threshold) : null;
    if (threshold != null && net > threshold + 0.001) throw new BadRequestException({ code: 'NETTING_EXCEEDS_THRESHOLD', message: `Net ${net} exceeds the agreed threshold ${threshold}`, messageTh: `ยอดหักกลบ ${net} เกินเพดานที่ตกลงไว้ ${threshold}` });
    if (!(net > 0)) throw new BadRequestException({ code: 'NOTHING_TO_NET', message: 'Net amount is zero', messageTh: 'ยอดหักกลบเป็นศูนย์' });

    const arLines = this.allocate(arRows, net);
    const apLines = this.allocate(apRows, net);
    const settlementNo = await this.docNo.nextDaily('NET');
    const head = (await this.db.insert(nettingSettlements).values({
      settlementNo, tenantId, agreementId: Number(agreement!.id), customerTenantId: Number(cust.id), vendorId: Number(vend.id),
      vendorName: vend.name, counterpartyName: cust.name ?? cust.code, currency: agreement!.currency ?? 'THB',
      arOpen: String(arOpen), apOpen: String(apOpen), netAmount: String(net), threshold: threshold != null ? String(threshold) : null,
      reason: dto.reason.trim(), status: 'PendingApproval', proposedBy: user.username,
    }).returning({ id: nettingSettlements.id }))[0]!;
    const lineVals = [
      ...arLines.map((l) => ({ settlementId: Number(head.id), tenantId, side: 'AR', docNo: l.doc_no, docOpen: String(l.open), appliedAmount: String(l.apply) })),
      ...apLines.map((l) => ({ settlementId: Number(head.id), tenantId, side: 'AP', docNo: l.doc_no, docOpen: String(l.open), appliedAmount: String(l.apply) })),
    ];
    if (lineVals.length) await this.db.insert(nettingSettlementLines).values(lineVals);
    await this.statusLog.log('NET', settlementNo, '', 'PendingApproval', user.username, `Propose netting ${net} (AR ${arOpen} vs AP ${apOpen}) — ${dto.reason.trim()}`);
    return {
      settlement_no: settlementNo, status: 'PendingApproval', pending: true,
      customer_tenant_id: Number(cust.id), vendor_id: Number(vend.id), vendor_name: vend.name,
      ar_open: arOpen, ap_open: apOpen, net_amount: net, residual_ar: round2(arOpen - net), residual_ap: round2(apOpen - net),
      ar_lines: arLines.map((l) => ({ invoice_no: l.doc_no, applied: l.apply })), ap_lines: apLines.map((l) => ({ txn_no: l.doc_no, applied: l.apply })),
      threshold, reason: dto.reason.trim(),
    };
  }

  // Apply an amount to an AR invoice under a row lock; recompute paid/status from the LOCKED value.
  private async applyToInvoice(tx: any, invoiceId: number, amt: number) {
    const [locked] = await tx.select().from(arInvoices).where(eq(arInvoices.id, invoiceId)).for('update').limit(1);
    const newPaid = round2(n(locked.paidAmount) + amt);
    const status = newPaid >= n(locked.amount) ? 'Paid' : newPaid > 0 ? 'Partial' : 'Unpaid';
    await tx.update(arInvoices).set({ paidAmount: String(newPaid), status }).where(eq(arInvoices.id, invoiceId));
    return { doc_no: locked.invoiceNo as string, status };
  }

  // Apply an amount to an AP bill under a row lock; recompute paid/status from the LOCKED value.
  private async applyToBill(tx: any, billId: number, amt: number) {
    const [locked] = await tx.select().from(apTransactions).where(eq(apTransactions.id, billId)).for('update').limit(1);
    const newPaid = round2(n(locked.paidAmount) + amt);
    const status = newPaid >= n(locked.amount) ? 'Paid' : newPaid > 0 ? 'Partial' : 'Unpaid';
    await tx.update(apTransactions).set({ paidAmount: String(newPaid), status }).where(eq(apTransactions.id, billId));
    return { doc_no: locked.txnNo as string, status };
  }

  // ── POST /api/finance/netting/settlements/:no/approve — checker applies the contra settlement (SoD) ──
  async approve(settlementNo: string, approver: JwtUser, selfApprovalReason?: string | null) {
    const db = this.db;
    const [head] = await db.select().from(nettingSettlements).where(eq(nettingSettlements.settlementNo, settlementNo)).limit(1);
    if (!head) throw new NotFoundException({ code: 'NOT_FOUND', message: `Settlement ${settlementNo} not found`, messageTh: 'ไม่พบรายการหักกลบ' });
    if (head.status !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Settlement ${settlementNo} is ${head.status}, not pending approval`, messageTh: 'รายการนี้ไม่ได้รออนุมัติ' });
    await assertMakerChecker(db, { user: approver, maker: head.proposedBy, event: 'ar.netting.approve', ref: settlementNo, amount: n(head.netAmount), reason: selfApprovalReason, code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot approve a netting settlement you proposed', messageTh: 'ผู้เสนอหักกลบอนุมัติรายการของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    const tenantId = head.tenantId != null ? Number(head.tenantId) : null;
    // Recompute from CURRENT open balances (a doc may have settled since propose) capped at the proposed net,
    // so the contra JE + both sub-ledger reliefs always tie out exactly.
    const { arRows, apRows, arOpen, apOpen } = await this.computeOpen(Number(head.customerTenantId), Number(head.vendorId), head.vendorName ?? null, tenantId);
    let net = round2(Math.min(arOpen, apOpen, n(head.netAmount)));
    if (!(net > 0)) throw new BadRequestException({ code: 'NOTHING_TO_NET', message: 'No open AR/AP left to net', messageTh: 'ไม่มียอดคงค้างให้หักกลบแล้ว' });
    const arLines = this.allocate(arRows, net);
    const apLines = this.allocate(apRows, net);
    const arApplied: any[] = [], apApplied: any[] = [];
    await db.transaction(async (tx: any) => {
      for (const l of arLines) arApplied.push({ ...(await this.applyToInvoice(tx, l.id, l.apply)), applied: l.apply, open: l.open });
      for (const l of apLines) apApplied.push({ ...(await this.applyToBill(tx, l.id, l.apply)), applied: l.apply, open: l.open });
      // Rewrite the statement lines to what was ACTUALLY offset (planned == actual when nothing changed).
      await tx.delete(nettingSettlementLines).where(eq(nettingSettlementLines.settlementId, Number(head.id)));
      const lineVals = [
        ...arLines.map((l) => ({ settlementId: Number(head.id), tenantId, side: 'AR', docNo: l.doc_no, docOpen: String(l.open), appliedAmount: String(l.apply) })),
        ...apLines.map((l) => ({ settlementId: Number(head.id), tenantId, side: 'AP', docNo: l.doc_no, docOpen: String(l.open), appliedAmount: String(l.apply) })),
      ];
      if (lineVals.length) await tx.insert(nettingSettlementLines).values(lineVals);
      await tx.update(nettingSettlements).set({ status: 'Approved', approvedBy: approver.username, approvedAt: new Date(), netAmount: String(net), arOpen: String(arOpen), apOpen: String(apOpen) }).where(eq(nettingSettlements.id, head.id));
    });
    // Contra JE — clear the AP control + relieve the AR control: Dr 2000 / Cr 1100 for the net amount.
    let entryNo: string | null = null;
    if (this.ledger && net > 0 && !(await this.ledger.alreadyPosted('NET', settlementNo, tenantId))) {
      const je: any = await this.ledger.postEntry({
        date: ymd(), source: 'NET', sourceRef: settlementNo, tenantId, viaSubledger: true,
        memo: `AR/AP netting ${settlementNo} — ${head.counterpartyName ?? head.vendorName ?? ''}`.trim(), createdBy: approver.username,
        lines: [{ account_code: '2000', debit: net }, { account_code: '1100', credit: net }],
      });
      entryNo = je?.entry_no ?? null;
      if (entryNo) await db.update(nettingSettlements).set({ jeEntryNo: entryNo }).where(eq(nettingSettlements.id, head.id));
    }
    await this.statusLog.log('NET', settlementNo, 'PendingApproval', 'Approved', approver.username);
    return {
      settlement_no: settlementNo, status: 'Approved', approved_by: approver.username, proposed_by: head.proposedBy ?? null,
      net_amount: net, je_entry_no: entryNo, ar_applied: arApplied, ap_applied: apApplied,
      residual_ar: round2(arOpen - net), residual_ap: round2(apOpen - net),
    };
  }

  // ── POST /api/finance/netting/settlements/:no/reject — checker declines (no GL/sub-ledger effect) ──
  async reject(settlementNo: string, approver: JwtUser, reason?: string) {
    const db = this.db;
    const [head] = await db.select().from(nettingSettlements).where(eq(nettingSettlements.settlementNo, settlementNo)).limit(1);
    if (!head) throw new NotFoundException({ code: 'NOT_FOUND', message: `Settlement ${settlementNo} not found`, messageTh: 'ไม่พบรายการหักกลบ' });
    if (head.status !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Settlement ${settlementNo} is ${head.status}, not pending approval`, messageTh: 'รายการนี้ไม่ได้รออนุมัติ' });
    await db.update(nettingSettlements).set({ status: 'Rejected', approvedBy: approver.username, approvedAt: new Date(), rejectReason: reason ?? null }).where(eq(nettingSettlements.id, head.id));
    await this.statusLog.log('NET', settlementNo, 'PendingApproval', 'Rejected', approver.username, reason);
    return { settlement_no: settlementNo, status: 'Rejected', rejected_by: approver.username };
  }

  // ── GET /api/finance/netting/settlements — the settlement register / pending queue ──
  async listSettlements(opts: { status?: string; limit?: number } = {}, user?: JwtUser) {
    const conds: any[] = [];
    if (opts.status) conds.push(eq(nettingSettlements.status, opts.status));
    if (user?.tenantId != null) conds.push(eq(nettingSettlements.tenantId, Number(user.tenantId)));
    const rows = await this.db.select().from(nettingSettlements).where(conds.length ? and(...conds) : undefined).orderBy(desc(nettingSettlements.id)).limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
    return {
      settlements: rows.map((r: any) => ({
        settlement_no: r.settlementNo, status: r.status, customer_tenant_id: Number(r.customerTenantId), vendor_id: Number(r.vendorId),
        vendor_name: r.vendorName, counterparty_name: r.counterpartyName, net_amount: n(r.netAmount), ar_open: n(r.arOpen), ap_open: n(r.apOpen),
        reason: r.reason, proposed_by: r.proposedBy, approved_by: r.approvedBy, je_entry_no: r.jeEntryNo, currency: r.currency,
      })),
      count: rows.length,
    };
  }

  // ── GET /api/finance/netting/settlements/:no — the netting statement (header + offset lines) ──
  async getSettlement(settlementNo: string) {
    const [head] = await this.db.select().from(nettingSettlements).where(eq(nettingSettlements.settlementNo, settlementNo)).limit(1);
    if (!head) throw new NotFoundException({ code: 'NOT_FOUND', message: `Settlement ${settlementNo} not found`, messageTh: 'ไม่พบรายการหักกลบ' });
    const lines = await this.db.select().from(nettingSettlementLines).where(eq(nettingSettlementLines.settlementId, Number(head.id))).orderBy(asc(nettingSettlementLines.id));
    return {
      settlement_no: head.settlementNo, status: head.status, customer_tenant_id: Number(head.customerTenantId), vendor_id: Number(head.vendorId),
      vendor_name: head.vendorName, counterparty_name: head.counterpartyName, currency: head.currency,
      ar_open: n(head.arOpen), ap_open: n(head.apOpen), net_amount: n(head.netAmount), threshold: head.threshold != null ? n(head.threshold) : null,
      residual_ar: round2(n(head.arOpen) - n(head.netAmount)), residual_ap: round2(n(head.apOpen) - n(head.netAmount)),
      reason: head.reason, proposed_by: head.proposedBy, proposed_at: head.proposedAt, approved_by: head.approvedBy, approved_at: head.approvedAt,
      reject_reason: head.rejectReason, je_entry_no: head.jeEntryNo,
      ar_lines: lines.filter((l: any) => l.side === 'AR').map((l: any) => ({ invoice_no: l.docNo, doc_open: n(l.docOpen), applied: n(l.appliedAmount) })),
      ap_lines: lines.filter((l: any) => l.side === 'AP').map((l: any) => ({ txn_no: l.docNo, doc_open: n(l.docOpen), applied: n(l.appliedAmount) })),
    };
  }
}
