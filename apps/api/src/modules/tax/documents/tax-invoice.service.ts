import { Inject, Injectable, Optional, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { taxInvoices, taxInvoiceLines, custPosSales, custPosItems, arInvoices, tenants } from '../../../database/schema';
import { DocNumberService } from '../../../common/doc-number.service';
import { TaxService } from '../tax.service';
import { LedgerService } from '../../ledger/ledger.service';
import { postingDefault } from '../../ledger/posting-events';
import { n, fx, ymd } from '../../../database/queries';
import type { JwtUser } from '../../../common/decorators';
import { assertMakerChecker } from '../../../common/control-profile';
import { appendAuditMeta } from '../../../common/tenant-context';
import { isUniqueViolation } from '../../../common/db-error';
import { sellerSnapshot, isValidTaxId } from './tax-docs.snapshot';
import type { IssueFullDto, ConvertAbbDto } from './dto';
import { EtaxService } from '../../pos/fiscal/etax.service';
import { CustomerMasterService } from '../../customers/customers.module';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

// Classify a free-text POS payment method (Cash/PromptPay/Transfer/Card/Comp/…) into the receipt's
// "ชำระเงินโดย" (Paid By) buckets — เงินสด/โอนเงิน/เช็คธนาคาร/อื่นๆ. Unrecognized methods fall to 'other'
// with the raw label preserved (paid_by_other) so no information is lost.
function classifyPaidBy(method: string | null | undefined): { paid_by: 'transfer' | 'cash' | 'cheque' | 'other'; paid_by_other: string | null } {
  const raw = String(method ?? '').trim();
  const s = raw.toLowerCase();
  if (!raw || /^cash$/.test(s) || /เงินสด/.test(raw)) return { paid_by: 'cash', paid_by_other: null };
  if (/transfer|promptpay|qr/.test(s) || /โอน/.test(raw)) return { paid_by: 'transfer', paid_by_other: null };
  if (/cheque|check/.test(s) || /เช็ค/.test(raw)) return { paid_by: 'cheque', paid_by_other: null };
  return { paid_by: 'other', paid_by_other: raw || null };
}

// dto for issuing a ใบลดหนี้/ใบเพิ่มหนี้ (credit/debit note) against a prior full tax invoice.
export interface AdjustmentNoteDto { original_doc_no: string; reason: string; lines: { description: string; qty?: number; unit_price?: number; amount: number }[] }

@Injectable()
export class TaxInvoiceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly tax: TaxService,
    @Optional() private readonly etax?: EtaxService,   // wiring: auto-submit full tax invoices to RD e-Tax
    @Optional() private readonly ledger?: LedgerService, // credit/debit-note GL posting (maker-checker, TAX-07)
    @Optional() private readonly customerMaster?: CustomerMasterService, // keeps the customer directory reusable (0269)
  ) {}

  private async tenantRow(tenantId: number) {
    const db = this.db;
    const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Seller (tenant) not found', messageTh: 'ไม่พบข้อมูลผู้ขาย' });
    return t;
  }

  private assertCanIssue(t: any) {
    if (!t.vatRegistered) {
      throw new BadRequestException({ code: 'NOT_VAT_REGISTERED', message: 'Seller is not VAT-registered; cannot issue a tax invoice', messageTh: 'ผู้ขายยังไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม จึงออกใบกำกับภาษีไม่ได้' });
    }
    if (!isValidTaxId(t.taxId)) {
      throw new BadRequestException({ code: 'INVALID_SELLER_TAXID', message: 'Seller Tax ID must be a valid 13-digit number', messageTh: 'เลขประจำตัวผู้เสียภาษีผู้ขายไม่ถูกต้อง (ต้อง 13 หลัก)' });
    }
  }

  // ── ใบกำกับภาษีอย่างย่อ (ม.86/6) จากการขายหน้าร้าน (VAT-inclusive slip) ──
  async issueAbbreviatedFromSale(saleNo: string, user: JwtUser) {
    const db = this.db;
    const [sale] = await db.select().from(custPosSales).where(eq(custPosSales.saleNo, saleNo)).limit(1);
    if (!sale) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Sale not found', messageTh: 'ไม่พบรายการขาย' });

    // idempotent: return the existing abbreviated invoice if already issued for this sale
    const [existing] = await db.select().from(taxInvoices)
      .where(and(eq(taxInvoices.sourceType, 'POS'), eq(taxInvoices.sourceRef, saleNo), eq(taxInvoices.type, 'abbreviated'))).limit(1);
    if (existing) return this.withLines(existing);

    const seller = await this.tenantRow(Number(sale.tenantId));
    this.assertCanIssue(seller);
    const items = await db.select().from(custPosItems).where(eq(custPosItems.saleId, Number(sale.id)));

    const subtotal = n(sale.subtotal);
    const vat = n(sale.taxAmount);
    const total = n(sale.total);
    const docNo = await this.docNo.nextMonthlyTenant('ATV', Number(sale.tenantId));

    const [head] = await db.insert(taxInvoices).values({
      tenantId: Number(sale.tenantId), docNo, type: 'abbreviated', issueDate: ymd(),
      sourceType: 'POS', sourceRef: saleNo, ...sellerSnapshot(seller),
      subtotal: fx(subtotal, 2), discount: fx(n(sale.discount), 2), vatRate: fx(n(seller.vatRate ?? 0.07), 4),
      vatAmount: fx(vat, 2), grandTotal: fx(total, 2), isVatInclusive: true,
      createdBy: user.username,
    }).returning({ id: taxInvoices.id });

    await this.insertLines(Number(head!.id), Number(sale.tenantId), items.map((it: any, i: number) => ({
      lineNo: i + 1, itemId: it.itemId, description: it.itemDescription ?? it.itemId ?? 'สินค้า',
      qty: n(it.qty), uom: it.uom, unitPrice: n(it.unitPrice), discount: n(0), amount: n(it.amount),
    })));
    return this.getByDocNo(user, docNo);
  }

  // ── ใบกำกับภาษีเต็มรูป (ม.86/4) จาก POS หรือ AR — VAT แยก, ต้องมีข้อมูลผู้ซื้อ ──
  async issueFull(dto: IssueFullDto, user: JwtUser) {
    const db = this.db;
    // buyer block mandatory (ม.86/4(3)); Tax ID optional but validated if provided
    if (!dto.buyer?.name || !dto.buyer?.address) {
      throw new BadRequestException({ code: 'BUYER_REQUIRED', message: 'Full tax invoice requires buyer name + address', messageTh: 'ใบกำกับภาษีเต็มรูปต้องมีชื่อและที่อยู่ผู้ซื้อ' });
    }
    if (dto.buyer.tax_id && !isValidTaxId(dto.buyer.tax_id)) {
      throw new BadRequestException({ code: 'INVALID_BUYER_TAXID', message: 'Buyer Tax ID must be 13 digits', messageTh: 'เลขประจำตัวผู้เสียภาษีผู้ซื้อต้อง 13 หลัก' });
    }

    let tenantId: number, subtotal: number, vat: number, total: number;
    let lines: any[] = [];
    // Receipt-style "ชำระเงินโดย" (Paid By) — for POS it's derived from the sale's own payment method
    // (already collected at the register); an explicit dto.payment always overrides (also the only source
    // for an AR-sourced invoice, which may not be paid yet — due_date covers that case instead).
    let derivedPayment: { paid_by: 'transfer' | 'cash' | 'cheque' | 'other'; paid_by_other: string | null } | null = null;

    if (dto.source_type === 'POS') {
      const [sale] = await db.select().from(custPosSales).where(eq(custPosSales.saleNo, dto.source_ref)).limit(1);
      if (!sale) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Sale not found', messageTh: 'ไม่พบรายการขาย' });
      tenantId = Number(sale.tenantId); subtotal = n(sale.subtotal); vat = n(sale.taxAmount); total = n(sale.total);
      const items = await db.select().from(custPosItems).where(eq(custPosItems.saleId, Number(sale.id)));
      lines = items.map((it: any, i: number) => ({ lineNo: i + 1, itemId: it.itemId, description: it.itemDescription ?? it.itemId ?? 'สินค้า', qty: n(it.qty), uom: it.uom, unitPrice: n(it.unitPrice), discount: n(0), amount: n(it.amount) }));
      derivedPayment = classifyPaidBy(sale.paymentMethod);
    } else {
      const [inv] = await db.select().from(arInvoices).where(eq(arInvoices.invoiceNo, dto.source_ref)).limit(1);
      if (!inv) throw new NotFoundException({ code: 'NOT_FOUND', message: 'AR invoice not found', messageTh: 'ไม่พบใบแจ้งหนี้' });
      tenantId = Number(inv.tenantId);
      const inc = await this.tax.calcInclusiveForTenant(tenantId, { gross: n(inv.amount), currency: inv.currency ?? 'THB' }); // AR amount = VAT-inclusive, tenant rate
      subtotal = inc.net; vat = inc.tax; total = inc.gross;
      lines = [{ lineNo: 1, itemId: null, description: `สินค้า/บริการตามใบแจ้งหนี้ ${dto.source_ref}`, qty: 1, uom: null, unitPrice: subtotal, discount: 0, amount: subtotal }];
    }
    const payment = dto.payment?.paid_by
      ? { paid_by: dto.payment.paid_by, paid_by_other: dto.payment.paid_by === 'other' ? (dto.payment.paid_by_other ?? null) : null }
      : derivedPayment;

    const seller = await this.tenantRow(tenantId);
    this.assertCanIssue(seller);
    const docNo = await this.docNo.nextMonthlyTenant('TIV', tenantId);
    const [head] = await db.insert(taxInvoices).values({
      tenantId, docNo, type: 'full', issueDate: ymd(), sourceType: dto.source_type, sourceRef: dto.source_ref,
      ...sellerSnapshot(seller),
      buyerName: dto.buyer.name, buyerTaxId: dto.buyer.tax_id ?? null, buyerBranchCode: dto.buyer.branch_code ?? null, buyerAddress: dto.buyer.address,
      subtotal: fx(subtotal, 2), vatRate: fx(n(seller.vatRate ?? 0.07), 4), vatAmount: fx(vat, 2), grandTotal: fx(total, 2), isVatInclusive: false,
      bookNo: dto.book_no ?? null, notes: dto.notes ?? null, createdBy: user.username,
      dueDate: dto.due_date ?? null, paidBy: payment?.paid_by ?? null, paidByOther: payment?.paid_by_other ?? null,
      paidBank: dto.payment?.bank ?? null, paidChequeNo: dto.payment?.cheque_no ?? null, paidBranch: dto.payment?.branch ?? null,
    }).returning({ id: taxInvoices.id });
    await this.insertLines(Number(head!.id), tenantId, lines);
    // wiring: hand the full tax invoice to the RD/ETDA e-Tax provider. Issuance must not fail just
    // because the SP is unreachable, so a submission error is swallowed HERE — but it is no longer
    // silent: EtaxService.submit() persists every failed attempt (status='Rejected') and raises an ops
    // alert before rethrowing, so it is visible via GET /api/tax/etax and picked up by the
    // etax_submission_retry BI job (see docs/ops/etax-production-spike.md gap #5).
    if (this.etax) { try { await this.etax.submit(docNo, undefined, user); } catch { /* recorded + alerted inside submit(); retried by the BI sweep */ } }
    // wiring (best-effort): keep the customer directory reusable so the buyer doesn't need retyping next time
    if (this.customerMaster) { try { await this.customerMaster.upsertFromInvoiceBuyer(dto.buyer, tenantId, user.username); } catch { /* directory update best-effort */ } }
    return this.getByDocNo(user, docNo);
  }

  // ── ABB → full conversion (ม.86/4 on buyer request; POS-1, TAX-10) ──
  // Thai retail legal expectation: a VAT-registered buyer may ask the seller to convert an abbreviated
  // slip (ม.86/6) into a FULL tax invoice (ม.86/4) so they can claim the input VAT. The conversion:
  //  - captures the buyer block (name + validated 13-digit Tax ID + 5-digit branch, default 00000 + address),
  //  - COPIES the ABB's amounts/VAT/lines verbatim (same supply — never recomputed),
  //  - keeps the ABB's issue date + tax point (the VAT stays in the original filing period; only the
  //    document FORM changes, like a ใบแทน per ม.86/12 practice),
  //  - links full.replaces_doc_no = ABB doc_no and flips the ABB to status 'Replaced', so the ภ.พ.30
  //    output-VAT report (status='Issued') counts the supply EXACTLY once,
  //  - is idempotent: converting an already-converted ABB returns the SAME full invoice (one full per ABB,
  //    DB-enforced by the partial unique index uq_tiv_converted_from, migration 0291).
  async convertAbbreviatedToFull(abbDocNo: string, dto: ConvertAbbDto, user: JwtUser) {
    const db = this.db;
    const [abb] = await db.select().from(taxInvoices).where(eq(taxInvoices.docNo, abbDocNo)).limit(1);
    if (!abb) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Abbreviated tax invoice not found', messageTh: 'ไม่พบใบกำกับภาษีอย่างย่อ' });
    if (abb.type !== 'abbreviated') {
      throw new BadRequestException({ code: 'NOT_ABBREVIATED', message: `Document is ${abb.type}, not an abbreviated tax invoice`, messageTh: 'เอกสารนี้ไม่ใช่ใบกำกับภาษีอย่างย่อ' });
    }
    const tenantId = Number(abb.tenantId);

    // Idempotent: one full invoice per ABB — a re-call returns the existing conversion unchanged.
    const findExisting = async () => {
      const [row] = await db.select().from(taxInvoices)
        .where(and(eq(taxInvoices.tenantId, tenantId), eq(taxInvoices.type, 'full'), eq(taxInvoices.replacesDocNo, abbDocNo))).limit(1);
      return row;
    };
    const existing = await findExisting();
    if (existing) return { ...(await this.withLines(existing)), already_converted: true };

    if (abb.status === 'Voided') {
      throw new BadRequestException({ code: 'ABB_VOIDED', message: 'A voided abbreviated tax invoice cannot be converted', messageTh: 'ใบกำกับภาษีอย่างย่อที่ถูกยกเลิกแล้ว แปลงเป็นเต็มรูปไม่ได้' });
    }
    if (abb.status !== 'Issued') {
      throw new BadRequestException({ code: 'ABB_NOT_CONVERTIBLE', message: `Abbreviated invoice is ${abb.status}, not Issued`, messageTh: 'ใบกำกับภาษีอย่างย่อไม่อยู่ในสถานะที่แปลงได้' });
    }
    // Buyer block mandatory (ม.86/4(3)); the Tax ID is REQUIRED here (the reason a buyer converts) and
    // checksum-validated; branch code defaults to 00000 = สำนักงานใหญ่ (5-digit format enforced by zod).
    if (!dto.buyer?.name || !dto.buyer?.address) {
      throw new BadRequestException({ code: 'BUYER_REQUIRED', message: 'Full tax invoice requires buyer name + address', messageTh: 'ใบกำกับภาษีเต็มรูปต้องมีชื่อและที่อยู่ผู้ซื้อ' });
    }
    if (!isValidTaxId(dto.buyer.tax_id)) {
      throw new BadRequestException({ code: 'INVALID_BUYER_TAXID', message: 'Buyer Tax ID must be a valid 13-digit number', messageTh: 'เลขประจำตัวผู้เสียภาษีผู้ซื้อไม่ถูกต้อง (ต้อง 13 หลัก)' });
    }
    const branchCode = dto.buyer.branch_code ?? '00000';

    const lines = await db.select().from(taxInvoiceLines).where(eq(taxInvoiceLines.taxInvoiceId, Number(abb.id))).orderBy(taxInvoiceLines.lineNo);
    // Receipt-style Paid By — derived from the POS sale exactly like issueFull (presentation, not ม.86/4).
    let payment: { paid_by: 'transfer' | 'cash' | 'cheque' | 'other'; paid_by_other: string | null } | null = null;
    if (abb.sourceType === 'POS') {
      const [sale] = await db.select().from(custPosSales).where(eq(custPosSales.saleNo, abb.sourceRef)).limit(1);
      if (sale) payment = classifyPaidBy(sale.paymentMethod);
    }

    const docNo = await this.docNo.nextMonthlyTenant('TIV', tenantId);
    try {
      const [head] = await db.insert(taxInvoices).values({
        tenantId, docNo, type: 'full',
        // Same supply, same tax point: the full invoice carries the ABB's dates so the VAT stays in the
        // original ภ.พ.30 period (the report drops the Replaced ABB and picks this row up instead).
        issueDate: abb.issueDate, taxPointDate: abb.taxPointDate ?? abb.issueDate, supplyType: abb.supplyType,
        sourceType: abb.sourceType, sourceRef: abb.sourceRef,
        // Seller block: reuse the ABB's frozen ม.86/4 snapshot — the converted document describes the
        // same historical supply, so it must not re-derive from the (possibly edited) tenant row.
        sellerName: abb.sellerName, sellerTaxId: abb.sellerTaxId, sellerBranchCode: abb.sellerBranchCode,
        sellerBranchLabel: abb.sellerBranchLabel, sellerAddress: abb.sellerAddress,
        buyerName: dto.buyer.name, buyerTaxId: dto.buyer.tax_id, buyerBranchCode: branchCode, buyerAddress: dto.buyer.address,
        // Amounts/VAT copied VERBATIM from the ABB — never recomputed (the slip already fixed them).
        currency: abb.currency, subtotal: abb.subtotal, discount: abb.discount, vatRate: abb.vatRate,
        vatAmount: abb.vatAmount, grandTotal: abb.grandTotal, isVatInclusive: false,
        replacesDocNo: abbDocNo, createdBy: user.username,
        paidBy: payment?.paid_by ?? null, paidByOther: payment?.paid_by_other ?? null,
      }).returning({ id: taxInvoices.id });
      await this.insertLines(Number(head!.id), tenantId, lines.map((l: any, i: number) => ({
        lineNo: i + 1, itemId: l.itemId, description: l.description, qty: l.qty != null ? n(l.qty) : null,
        uom: l.uom, unitPrice: l.unitPrice != null ? n(l.unitPrice) : null, discount: n(l.discount), amount: n(l.amount),
      })));
    } catch (e) {
      // Concurrency backstop: uq_tiv_converted_from (0291) — the other converter won; return its invoice.
      if (isUniqueViolation(e)) {
        const winner = await findExisting();
        if (winner) return { ...(await this.withLines(winner)), already_converted: true };
      }
      throw e;
    }
    // Supersede the ABB (status drives the output-VAT single-count; the number is retained, never reused).
    await db.update(taxInvoices).set({ status: 'Replaced' }).where(eq(taxInvoices.id, abb.id));
    // Durable audit evidence on this request's hash-chained audit_log row (TAX-10).
    appendAuditMeta({ tax_abb_convert: { abb_doc_no: abbDocNo, full_doc_no: docNo, buyer_tax_id: dto.buyer.tax_id, buyer_branch_code: branchCode } });
    // Same downstream wiring as issueFull: e-Tax submission (best-effort, failure recorded+retried inside
    // submit) and the reusable customer directory.
    if (this.etax) { try { await this.etax.submit(docNo, undefined, user); } catch { /* recorded + alerted inside submit(); retried by the BI sweep */ } }
    if (this.customerMaster) { try { await this.customerMaster.upsertFromInvoiceBuyer({ ...dto.buyer, branch_code: branchCode }, tenantId, user.username); } catch { /* directory update best-effort */ } }
    return { ...(await this.getByDocNo(user, docNo)), already_converted: false };
  }

  private async insertLines(taxInvoiceId: number, tenantId: number, lines: any[]) {
    if (!lines.length) return;
    const db = this.db;
    await db.insert(taxInvoiceLines).values(lines.map((l) => ({
      taxInvoiceId, tenantId, lineNo: String(l.lineNo), itemId: l.itemId ?? null, description: l.description,
      qty: l.qty != null ? fx(l.qty, 3) : null, uom: l.uom ?? null,
      unitPrice: l.unitPrice != null ? fx(l.unitPrice, 2) : null, discount: fx(l.discount ?? 0, 2), amount: fx(l.amount, 2),
    })));
  }

  async list(user: JwtUser, type?: string, limit = 50) {
    const db = this.db;
    const where = type ? eq(taxInvoices.type, type as typeof taxInvoices.$inferSelect.type) : undefined;
    const rows = await db.select().from(taxInvoices).where(where).orderBy(desc(taxInvoices.id)).limit(limit);
    return { invoices: rows.map(shape), count: rows.length };
  }

  async getByDocNo(user: JwtUser, docNo: string) {
    const db = this.db;
    const [head] = await db.select().from(taxInvoices).where(eq(taxInvoices.docNo, docNo)).limit(1);
    if (!head) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Tax invoice not found', messageTh: 'ไม่พบใบกำกับภาษี' });
    return this.withLines(head);
  }

  private async withLines(head: any) {
    const db = this.db;
    const lines = await db.select().from(taxInvoiceLines).where(eq(taxInvoiceLines.taxInvoiceId, Number(head.id))).orderBy(taxInvoiceLines.lineNo);
    const shaped = shape(head);
    // The seller name/address/tax-id are an immutable ม.86/4 snapshot; the logo/phone/fax are presentation
    // (contact info, not a statutory ม.86/4 particular), so read the tenant's CURRENT values at render time.
    let logoUrl: string | null = null, phone: string | null = null, fax: string | null = null;
    if (head.tenantId != null) {
      const [t] = await db.select({ logoUrl: tenants.logoUrl, phone: tenants.phone, fax: tenants.fax }).from(tenants).where(eq(tenants.id, Number(head.tenantId))).limit(1);
      logoUrl = t?.logoUrl ?? null; phone = t?.phone ?? null; fax = t?.fax ?? null;
    }
    return { ...shaped, seller: { ...shaped.seller, logo_url: logoUrl, phone, fax }, lines: lines.map(shapeLine) };
  }

  // ── ใบลดหนี้ (ม.86/10) / ใบเพิ่มหนี้ (ม.86/9) — adjust a prior full tax invoice ──
  // Issued as PendingApproval + a Draft GL entry; a DIFFERENT user approves (approveAdjustment → GL-05 SoD),
  // which flips the note to Issued AND posts the GL. Amounts are the POSITIVE magnitude of the difference;
  // the output-VAT report signs them by type (credit − / debit +) for the note's issue period.
  async issueAdjustment(kind: 'credit_note' | 'debit_note', dto: AdjustmentNoteDto, user: JwtUser) {
    const db = this.db;
    if (!dto.reason?.trim()) {
      throw new BadRequestException({ code: 'REASON_REQUIRED', message: 'A reason is required (ม.86/10(4))', messageTh: 'ต้องระบุเหตุผลการออกใบลดหนี้/เพิ่มหนี้' });
    }
    const [orig] = await db.select().from(taxInvoices).where(eq(taxInvoices.docNo, dto.original_doc_no)).limit(1);
    if (!orig) throw new NotFoundException({ code: 'ORIGINAL_NOT_FOUND', message: 'Original tax invoice not found', messageTh: 'ไม่พบใบกำกับภาษีที่อ้างถึง' });
    if (orig.status !== 'Issued') throw new BadRequestException({ code: 'ORIGINAL_NOT_ISSUED', message: `Original is ${orig.status}, not Issued`, messageTh: 'ใบกำกับภาษีต้นทางไม่อยู่ในสถานะออกแล้ว' });
    if (orig.type === 'credit_note' || orig.type === 'debit_note') {
      throw new BadRequestException({ code: 'CANNOT_ADJUST_A_NOTE', message: 'Cannot issue a note against another note', messageTh: 'ออกใบลดหนี้/เพิ่มหนี้อ้างอิงใบลดหนี้/เพิ่มหนี้ไม่ได้' });
    }
    const tenantId = Number(orig.tenantId);
    const seller = await this.tenantRow(tenantId);
    this.assertCanIssue(seller);

    const lines = (dto.lines ?? []).filter((l) => n(l.amount) !== 0);
    if (!lines.length) throw new BadRequestException({ code: 'NO_LINES', message: 'No adjustment lines', messageTh: 'ไม่มีรายการปรับปรุง' });
    const subtotal = round2(lines.reduce((a, l) => a + n(l.amount), 0));
    if (subtotal <= 0) throw new BadRequestException({ code: 'INVALID_AMOUNT', message: 'Adjustment amount must be positive', messageTh: 'มูลค่าปรับปรุงต้องมากกว่าศูนย์' });
    // A credit note cannot reduce the sale by more than the original net value (ม.82/10 basis).
    if (kind === 'credit_note' && subtotal > n(orig.subtotal) + 0.005) {
      throw new BadRequestException({ code: 'CREDIT_EXCEEDS_ORIGINAL', message: `Credit ${subtotal} exceeds original net ${n(orig.subtotal)}`, messageTh: 'มูลค่าลดหนี้เกินมูลค่าตามใบกำกับภาษีเดิม' });
    }
    const vatRate = n(orig.vatRate);
    const vat = round2(subtotal * vatRate);
    const total = round2(subtotal + vat);
    const prefix = kind === 'credit_note' ? 'CN' : 'DN';
    const docNo = await this.docNo.nextMonthlyTenant(prefix, tenantId);

    // Draft GL (maker-checker): a credit note REVERSES the sale (Dr revenue + Dr output-VAT / Cr AR); a debit
    // note ADDS to it (Dr AR / Cr revenue + Cr output-VAT). Posted to the AR control account via subledger.
    let je: any = null;
    if (this.ledger) {
      // docs/43 PR-2: revenue/VAT legs follow the tenant posting-rules (SALE.FOOD / SALE.VAT) ?? registry
      // defaults; the AR control leg (1100) is REC-04-pinned and stays literal.
      const [saleOvr, vatOvr] = await Promise.all([
        this.ledger.postingOverrides('SALE.FOOD', tenantId),
        this.ledger.postingOverrides('SALE.VAT', tenantId),
      ]);
      const revAcct = saleOvr.revenue ?? postingDefault('SALE.FOOD', 'revenue');
      const vatAcct = vatOvr.vat_output ?? postingDefault('SALE.VAT', 'vat_output');
      const glLines = kind === 'credit_note'
        ? [{ account_code: revAcct, debit: subtotal, memo: `ใบลดหนี้ ${docNo}` }, { account_code: vatAcct, debit: vat, memo: 'กลับภาษีขาย' }, { account_code: '1100', credit: total, memo: `ลดลูกหนี้ ${orig.buyerName ?? ''}` }]
        : [{ account_code: '1100', debit: total, memo: `เพิ่มลูกหนี้ ${orig.buyerName ?? ''}` }, { account_code: revAcct, credit: subtotal, memo: `ใบเพิ่มหนี้ ${docNo}` }, { account_code: vatAcct, credit: vat, memo: 'ภาษีขายเพิ่ม' }];
      je = await this.ledger.postEntry({
        source: prefix, sourceRef: docNo, tenantId, createdBy: user.username, viaSubledger: true, pendingApproval: true,
        memo: `${kind === 'credit_note' ? 'ใบลดหนี้' : 'ใบเพิ่มหนี้'} ${docNo} (อ้างอิง ${orig.docNo})`, lines: glLines,
      });
    }

    const [head] = await db.insert(taxInvoices).values({
      tenantId, docNo, type: kind, issueDate: ymd(), sourceType: orig.sourceType, sourceRef: orig.sourceRef,
      ...sellerSnapshot(seller),
      buyerName: orig.buyerName, buyerTaxId: orig.buyerTaxId, buyerBranchCode: orig.buyerBranchCode, buyerAddress: orig.buyerAddress,
      subtotal: fx(subtotal, 2), vatRate: fx(vatRate, 4), vatAmount: fx(vat, 2), grandTotal: fx(total, 2), isVatInclusive: false,
      status: 'PendingApproval', originalDocNo: orig.docNo, reason: dto.reason.trim(), glEntryNo: je?.entry_no ?? null, createdBy: user.username,
    }).returning({ id: taxInvoices.id });
    await this.insertLines(Number(head!.id), tenantId, lines.map((l, i) => ({
      lineNo: i + 1, itemId: null, description: l.description, qty: l.qty ?? null, uom: null, unitPrice: l.unit_price ?? null, discount: 0, amount: n(l.amount),
    })));
    return { ...(await this.getByDocNo(user, docNo)), gl_entry_no: je?.entry_no ?? null, gl_status: je ? 'Draft' : null };
  }

  // Checker approves the note: SoD-blocked if approver === maker (also re-enforced by the ledger). Posts the
  // linked Draft GL entry (→ VAT/GL land) and flips the note PendingApproval → Issued (→ hits the VAT report).
  async approveAdjustment(docNo: string, approver: JwtUser, selfApprovalReason?: string | null) {
    const db = this.db;
    const [head] = await db.select().from(taxInvoices).where(eq(taxInvoices.docNo, docNo)).limit(1);
    if (!head) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Note not found', messageTh: 'ไม่พบเอกสาร' });
    if (head.type !== 'credit_note' && head.type !== 'debit_note') throw new BadRequestException({ code: 'NOT_A_NOTE', message: 'Not a credit/debit note', messageTh: 'ไม่ใช่ใบลดหนี้/เพิ่มหนี้' });
    if (head.status !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Note is ${head.status}, not pending`, messageTh: 'เอกสารไม่ได้รออนุมัติ' });
    await assertMakerChecker(db, { user: approver, maker: head.createdBy, event: 'tax.adjustment.approve', ref: docNo, amount: n(head.grandTotal), reason: selfApprovalReason, code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot approve a note you issued', messageTh: 'ผู้ออกเอกสารอนุมัติเองไม่ได้ (แบ่งแยกหน้าที่)' });
    let gl: any = null;
    if (head.glEntryNo && this.ledger) gl = await this.ledger.approveEntry(head.glEntryNo, approver, selfApprovalReason); // posts GL + re-enforces SoD
    await db.update(taxInvoices).set({ status: 'Issued' }).where(eq(taxInvoices.id, head.id));
    return { doc_no: docNo, status: 'Issued', gl: gl ? { entry_no: gl.entry_no, status: gl.status } : null };
  }

  async rejectAdjustment(docNo: string, approver: JwtUser, reason?: string) {
    const db = this.db;
    const [head] = await db.select().from(taxInvoices).where(eq(taxInvoices.docNo, docNo)).limit(1);
    if (!head) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Note not found', messageTh: 'ไม่พบเอกสาร' });
    if (head.status !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Note is ${head.status}, not pending`, messageTh: 'เอกสารไม่ได้รออนุมัติ' });
    if (head.glEntryNo && this.ledger) await this.ledger.rejectEntry(head.glEntryNo, approver, reason);
    await db.update(taxInvoices).set({ status: 'Voided', voidReason: reason ?? null }).where(eq(taxInvoices.id, head.id));
    return { doc_no: docNo, status: 'Voided' };
  }

  async void(user: JwtUser, docNo: string, reason: string) {
    const db = this.db;
    const [head] = await db.select().from(taxInvoices).where(eq(taxInvoices.docNo, docNo)).limit(1);
    if (!head) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Tax invoice not found', messageTh: 'ไม่พบใบกำกับภาษี' });
    // numbers are NEVER reused — keep the row, flip status (RD requirement).
    await db.update(taxInvoices).set({ status: 'Voided', voidReason: reason ?? null }).where(eq(taxInvoices.id, head.id));
    return { doc_no: docNo, status: 'Voided' };
  }

  // G16 (maker-checker audit — detective): a void of an issued fiscal document is single-user (sequence-/
  // audit-logged; credit/debit NOTES are separately dual-controlled via TAX-07). This read-only EXCEPTION
  // REPORT lists every VOIDED tax invoice (doc no, reason, amount, who/when) for independent periodic review,
  // so the residual risk is detective-covered. Tenant-scoped (RLS); optional [from,to] on issue_date.
  async voidedExceptions(user: JwtUser, range: { from?: string; to?: string }) {
    const db = this.db;
    const conds: any[] = [eq(taxInvoices.status, 'Voided')];
    if (range.from) conds.push(sql`${taxInvoices.issueDate} >= ${range.from}`);
    if (range.to) conds.push(sql`${taxInvoices.issueDate} <= ${range.to}`);
    const rows = await db.select({ docNo: taxInvoices.docNo, type: taxInvoices.type, issueDate: taxInvoices.issueDate, sourceType: taxInvoices.sourceType, sourceRef: taxInvoices.sourceRef, grandTotal: taxInvoices.grandTotal, voidReason: taxInvoices.voidReason, createdBy: taxInvoices.createdBy })
      .from(taxInvoices).where(and(...conds)).orderBy(desc(taxInvoices.id)).limit(500);
    const total = rows.reduce((a: number, r: any) => a + n(r.grandTotal), 0);
    return {
      from: range.from ?? null, to: range.to ?? null,
      voided: rows.map((r: any) => ({ doc_no: r.docNo, type: r.type, issue_date: r.issueDate, source_type: r.sourceType, source_ref: r.sourceRef, grand_total: n(r.grandTotal), void_reason: r.voidReason, created_by: r.createdBy })),
      count: rows.length, total: Math.round(total * 100) / 100,
    };
  }
}

function shape(r: any) {
  return {
    doc_no: r.docNo, type: r.type, status: r.status, issue_date: r.issueDate,
    source_type: r.sourceType, source_ref: r.sourceRef,
    seller: { name: r.sellerName, tax_id: r.sellerTaxId, branch_code: r.sellerBranchCode, branch_label: r.sellerBranchLabel, address: r.sellerAddress },
    buyer: r.buyerName ? { name: r.buyerName, tax_id: r.buyerTaxId, branch_code: r.buyerBranchCode, address: r.buyerAddress } : null,
    currency: r.currency, subtotal: n(r.subtotal), discount: n(r.discount), vat_rate: n(r.vatRate),
    vat_amount: n(r.vatAmount), grand_total: n(r.grandTotal), is_vat_inclusive: r.isVatInclusive,
    book_no: r.bookNo, notes: r.notes, created_by: r.createdBy, created_at: r.createdAt,
    // credit/debit note fields (null on ordinary invoices)
    original_doc_no: r.originalDocNo ?? null, reason: r.reason ?? null, gl_entry_no: r.glEntryNo ?? null,
    // ABB→full conversion linkage (TAX-10): on a converted full invoice, the superseded ABB's doc no.
    replaces_doc_no: r.replacesDocNo ?? null,
    // receipt-style payment fields (0268) — presentation/data-adjacent, not ม.86/4-mandatory
    due_date: r.dueDate ?? null,
    payment: r.paidBy ? { paid_by: r.paidBy, paid_by_other: r.paidByOther ?? null, bank: r.paidBank ?? null, cheque_no: r.paidChequeNo ?? null, branch: r.paidBranch ?? null } : null,
  };
}
function shapeLine(l: any) {
  return { line_no: n(l.lineNo), item_id: l.itemId, description: l.description, qty: l.qty != null ? n(l.qty) : null, uom: l.uom, unit_price: l.unitPrice != null ? n(l.unitPrice) : null, discount: n(l.discount), amount: n(l.amount) };
}
