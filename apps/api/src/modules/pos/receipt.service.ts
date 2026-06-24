import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, and, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { custPosSales, custPosItems, tenants, receiptPrints } from '../../database/schema';
import { PaymentService } from '../payments/payments.service';
import { TaxDocsPdfService } from '../tax-docs/tax-docs-pdf.service';
import { sellerSnapshot } from '../tax-docs/tax-docs.snapshot';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { receiptHtml, receiptEscPos, type ReceiptModel } from './receipt-format';

// Receipt (ใบเสร็จรับเงิน) over a cust_pos_sales row — a THIRD document, distinct from the tax invoice.
// No GL. Works for VAT-unregistered tenants too (a receipt is not a tax invoice → no assertCanIssue).
@Injectable()
export class ReceiptService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly payments: PaymentService,
    private readonly pdf: TaxDocsPdfService,
  ) {}

  // Immutable model from a sale. Idempotent body; copy/reprint flags are set by the render methods.
  async buildModel(saleNo: string): Promise<{ model: ReceiptModel; tenantId: number | null }> {
    const db = this.db as any;
    const [sale] = await db.select().from(custPosSales).where(eq(custPosSales.saleNo, saleNo)).limit(1);
    if (!sale) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Sale not found', messageTh: 'ไม่พบรายการขาย' });
    const [t] = sale.tenantId != null ? await db.select().from(tenants).where(eq(tenants.id, Number(sale.tenantId))).limit(1) : [null];
    const snap = t ? sellerSnapshot(t) : { sellerName: 'ร้านค้า', sellerTaxId: '', sellerBranchLabel: '-', sellerAddress: '-' };
    const lines = await db.select().from(custPosItems).where(eq(custPosItems.saleId, Number(sale.id)));
    const paid: any = await this.payments.listPaymentsForSale(saleNo);
    const tenders = (paid.payments ?? []).length
      ? paid.payments.map((p: any) => ({ method: p.method, amount: n(p.amount), status: p.status }))
      : [{ method: sale.paymentMethod ?? 'Cash', amount: n(sale.total), status: 'Captured' }];
    const model: ReceiptModel = {
      sale_no: sale.saleNo,
      date: String(sale.saleDate ?? ''),
      shop: { name: snap.sellerName, tax_id: snap.sellerTaxId, branch_label: snap.sellerBranchLabel, address: snap.sellerAddress, phone: t?.phone ?? undefined },
      lines: lines.map((l: any) => ({ name: l.itemDescription ?? l.itemId, qty: n(l.qty), unit_price: n(l.unitPrice), amount: n(l.amount), discount_pct: n(l.discountPct) })),
      subtotal: n(sale.subtotal), discount: n(sale.discount), service_charge: n(sale.serviceCharge), vat: n(sale.taxAmount), total: n(sale.total), tip: n(sale.tip),
      tenders,
      points_earned: n(sale.pointsEarned), points_used: n(sale.pointsUsed),
      reprint_count: 0, copy: false,
    };
    return { model, tenantId: sale.tenantId ?? null };
  }

  // number of prior print rows for this sale (0 = original)
  private async reprintCount(saleNo: string): Promise<number> {
    const db = this.db as any;
    const [row] = await db.select({ c: sql<string>`count(*)` }).from(receiptPrints).where(and(eq(receiptPrints.saleNo, saleNo), eq(receiptPrints.channel, 'print')));
    return Number(row?.c ?? 0);
  }
  private async recordPrint(saleNo: string, tenantId: number | null, channel: string, isCopy: boolean, user: JwtUser) {
    const db = this.db as any;
    await db.insert(receiptPrints).values({ saleNo, tenantId, channel, isCopy: isCopy ? 'true' : 'false', printedBy: user.username });
  }

  async renderHtml(saleNo: string, user: JwtUser): Promise<{ html: string; copy: boolean; reprint_count: number }> {
    const { model, tenantId } = await this.buildModel(saleNo);
    const prior = await this.reprintCount(saleNo);
    model.copy = prior > 0; model.reprint_count = prior;
    await this.recordPrint(saleNo, tenantId, 'print', model.copy, user);
    return { html: receiptHtml(model), copy: model.copy, reprint_count: prior };
  }

  async renderEscPos(saleNo: string, user: JwtUser): Promise<{ text: string; copy: boolean }> {
    const { model, tenantId } = await this.buildModel(saleNo);
    const prior = await this.reprintCount(saleNo);
    model.copy = prior > 0; model.reprint_count = prior;
    await this.recordPrint(saleNo, tenantId, 'print', model.copy, user);
    return { text: receiptEscPos(model), copy: model.copy };
  }

  async renderPdfOrHtml(saleNo: string, user: JwtUser): Promise<{ pdf: Buffer | null; html: string; copy: boolean }> {
    const { model, tenantId } = await this.buildModel(saleNo);
    const prior = await this.reprintCount(saleNo);
    model.copy = prior > 0; model.reprint_count = prior;
    await this.recordPrint(saleNo, tenantId, 'print', model.copy, user);
    const html = receiptHtml(model);
    const pdf = await this.pdf.renderToPdf(html, true); // null when Chromium absent → caller sends html
    return { pdf, html, copy: model.copy };
  }

  // build the HTML/text body for delivery without recording a 'print' row (delivery records its own row)
  async bodyFor(saleNo: string, kind: 'html' | 'text'): Promise<string> {
    const { model } = await this.buildModel(saleNo);
    return kind === 'html' ? receiptHtml(model) : receiptEscPos(model);
  }
}
