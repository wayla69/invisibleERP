import { Inject, Injectable, Optional, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { taxInvoices, taxInvoiceLines, custPosSales, custPosItems, arInvoices, tenants } from '../../../database/schema';
import { DocNumberService } from '../../../common/doc-number.service';
import { TaxService } from '../tax.service';
import { n, fx, ymd } from '../../../database/queries';
import type { JwtUser } from '../../../common/decorators';
import { sellerSnapshot, isValidTaxId } from './tax-docs.snapshot';
import type { IssueFullDto } from './dto';
import { EtaxService } from '../../pos-fiscal/etax.service';

@Injectable()
export class TaxInvoiceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly tax: TaxService,
    @Optional() private readonly etax?: EtaxService,   // wiring: auto-submit full tax invoices to RD e-Tax
  ) {}

  private async tenantRow(tenantId: number) {
    const db = this.db as any;
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
    const db = this.db as any;
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

    await this.insertLines(Number(head.id), Number(sale.tenantId), items.map((it: any, i: number) => ({
      lineNo: i + 1, itemId: it.itemId, description: it.itemDescription ?? it.itemId ?? 'สินค้า',
      qty: n(it.qty), uom: it.uom, unitPrice: n(it.unitPrice), discount: n(0), amount: n(it.amount),
    })));
    return this.getByDocNo(user, docNo);
  }

  // ── ใบกำกับภาษีเต็มรูป (ม.86/4) จาก POS หรือ AR — VAT แยก, ต้องมีข้อมูลผู้ซื้อ ──
  async issueFull(dto: IssueFullDto, user: JwtUser) {
    const db = this.db as any;
    // buyer block mandatory (ม.86/4(3)); Tax ID optional but validated if provided
    if (!dto.buyer?.name || !dto.buyer?.address) {
      throw new BadRequestException({ code: 'BUYER_REQUIRED', message: 'Full tax invoice requires buyer name + address', messageTh: 'ใบกำกับภาษีเต็มรูปต้องมีชื่อและที่อยู่ผู้ซื้อ' });
    }
    if (dto.buyer.tax_id && !isValidTaxId(dto.buyer.tax_id)) {
      throw new BadRequestException({ code: 'INVALID_BUYER_TAXID', message: 'Buyer Tax ID must be 13 digits', messageTh: 'เลขประจำตัวผู้เสียภาษีผู้ซื้อต้อง 13 หลัก' });
    }

    let tenantId: number, subtotal: number, vat: number, total: number;
    let lines: any[] = [];

    if (dto.source_type === 'POS') {
      const [sale] = await db.select().from(custPosSales).where(eq(custPosSales.saleNo, dto.source_ref)).limit(1);
      if (!sale) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Sale not found', messageTh: 'ไม่พบรายการขาย' });
      tenantId = Number(sale.tenantId); subtotal = n(sale.subtotal); vat = n(sale.taxAmount); total = n(sale.total);
      const items = await db.select().from(custPosItems).where(eq(custPosItems.saleId, Number(sale.id)));
      lines = items.map((it: any, i: number) => ({ lineNo: i + 1, itemId: it.itemId, description: it.itemDescription ?? it.itemId ?? 'สินค้า', qty: n(it.qty), uom: it.uom, unitPrice: n(it.unitPrice), discount: n(0), amount: n(it.amount) }));
    } else {
      const [inv] = await db.select().from(arInvoices).where(eq(arInvoices.invoiceNo, dto.source_ref)).limit(1);
      if (!inv) throw new NotFoundException({ code: 'NOT_FOUND', message: 'AR invoice not found', messageTh: 'ไม่พบใบแจ้งหนี้' });
      tenantId = Number(inv.tenantId);
      const inc = await this.tax.calcInclusiveForTenant(tenantId, { gross: n(inv.amount), currency: inv.currency ?? 'THB' }); // AR amount = VAT-inclusive, tenant rate
      subtotal = inc.net; vat = inc.tax; total = inc.gross;
      lines = [{ lineNo: 1, itemId: null, description: `สินค้า/บริการตามใบแจ้งหนี้ ${dto.source_ref}`, qty: 1, uom: null, unitPrice: subtotal, discount: 0, amount: subtotal }];
    }

    const seller = await this.tenantRow(tenantId);
    this.assertCanIssue(seller);
    const docNo = await this.docNo.nextMonthlyTenant('TIV', tenantId);
    const [head] = await db.insert(taxInvoices).values({
      tenantId, docNo, type: 'full', issueDate: ymd(), sourceType: dto.source_type, sourceRef: dto.source_ref,
      ...sellerSnapshot(seller),
      buyerName: dto.buyer.name, buyerTaxId: dto.buyer.tax_id ?? null, buyerBranchCode: dto.buyer.branch_code ?? null, buyerAddress: dto.buyer.address,
      subtotal: fx(subtotal, 2), vatRate: fx(n(seller.vatRate ?? 0.07), 4), vatAmount: fx(vat, 2), grandTotal: fx(total, 2), isVatInclusive: false,
      bookNo: dto.book_no ?? null, notes: dto.notes ?? null, createdBy: user.username,
    }).returning({ id: taxInvoices.id });
    await this.insertLines(Number(head.id), tenantId, lines);
    // wiring (best-effort): hand the full tax invoice to the RD/ETDA e-Tax provider
    if (this.etax) { try { await this.etax.submit(docNo, undefined, user); } catch { /* e-Tax submit best-effort */ } }
    return this.getByDocNo(user, docNo);
  }

  private async insertLines(taxInvoiceId: number, tenantId: number, lines: any[]) {
    if (!lines.length) return;
    const db = this.db as any;
    await db.insert(taxInvoiceLines).values(lines.map((l) => ({
      taxInvoiceId, tenantId, lineNo: String(l.lineNo), itemId: l.itemId ?? null, description: l.description,
      qty: l.qty != null ? fx(l.qty, 3) : null, uom: l.uom ?? null,
      unitPrice: l.unitPrice != null ? fx(l.unitPrice, 2) : null, discount: fx(l.discount ?? 0, 2), amount: fx(l.amount, 2),
    })));
  }

  async list(user: JwtUser, type?: string, limit = 50) {
    const db = this.db as any;
    const where = type ? eq(taxInvoices.type, type as any) : undefined;
    const rows = await db.select().from(taxInvoices).where(where).orderBy(desc(taxInvoices.id)).limit(limit);
    return { invoices: rows.map(shape), count: rows.length };
  }

  async getByDocNo(user: JwtUser, docNo: string) {
    const db = this.db as any;
    const [head] = await db.select().from(taxInvoices).where(eq(taxInvoices.docNo, docNo)).limit(1);
    if (!head) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Tax invoice not found', messageTh: 'ไม่พบใบกำกับภาษี' });
    return this.withLines(head);
  }

  private async withLines(head: any) {
    const db = this.db as any;
    const lines = await db.select().from(taxInvoiceLines).where(eq(taxInvoiceLines.taxInvoiceId, Number(head.id))).orderBy(taxInvoiceLines.lineNo);
    return { ...shape(head), lines: lines.map(shapeLine) };
  }

  async void(user: JwtUser, docNo: string, reason: string) {
    const db = this.db as any;
    const [head] = await db.select().from(taxInvoices).where(eq(taxInvoices.docNo, docNo)).limit(1);
    if (!head) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Tax invoice not found', messageTh: 'ไม่พบใบกำกับภาษี' });
    // numbers are NEVER reused — keep the row, flip status (RD requirement).
    await db.update(taxInvoices).set({ status: 'Voided', voidReason: reason ?? null }).where(eq(taxInvoices.id, head.id));
    return { doc_no: docNo, status: 'Voided' };
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
  };
}
function shapeLine(l: any) {
  return { line_no: n(l.lineNo), item_id: l.itemId, description: l.description, qty: l.qty != null ? n(l.qty) : null, uom: l.uom, unit_price: l.unitPrice != null ? n(l.unitPrice) : null, discount: n(l.discount), amount: n(l.amount) };
}
