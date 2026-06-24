import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { custPosSales, custPosItems, tenants } from '../../database/schema';
import { DocumentTemplatesService } from '../document-templates/document-templates.service';
import {
  renderReceiptHtml, renderReceiptEscPos, normalizeReceiptTemplate, DEFAULT_RECEIPT_TEMPLATE,
  type ReceiptData, type ReceiptLang,
} from './receipt-render';

// Re-export the receipt types from their new home so existing importers keep working.
export type { ReceiptData, ReceiptLang } from './receipt-render';

const n = (x: any) => Number(x) || 0;

// Renders a customer receipt for a sale into a normalized data object, an HTML document (for browser/email
// print) and an ESC/POS byte string (for thermal printers). A receipt is a NON-fiscal courtesy document —
// the tax invoice (tax-docs) is the fiscal record — so this never posts to the ledger. Presentation is
// driven by the tenant's active receipt template (Platform Phase 10); absent one, the built-in default.
@Injectable()
export class ReceiptService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docTemplates: DocumentTemplatesService,
  ) {}

  async loadData(saleNo: string, opts?: { isCopy?: boolean; taxInvoiceNo?: string | null; lang?: ReceiptLang }): Promise<ReceiptData> {
    const db = this.db as any;
    const [sale] = await db.select().from(custPosSales).where(eq(custPosSales.saleNo, saleNo)).limit(1);
    if (!sale) throw new NotFoundException({ code: 'SALE_NOT_FOUND', message: 'Sale not found', messageTh: 'ไม่พบรายการขาย' });
    const lines = await db.select().from(custPosItems).where(eq(custPosItems.saleId, Number(sale.id)));
    let seller: any = null;
    if (sale.tenantId != null) [seller] = await db.select().from(tenants).where(eq(tenants.id, Number(sale.tenantId))).limit(1);
    const addr = seller ? [seller.addressLine1, seller.addressLine2, seller.subDistrict, seller.district, seller.province, seller.postalCode].filter(Boolean).join(' ') : '';
    // language: explicit override > tenant default > th
    const lang: ReceiptLang = opts?.lang ?? ((seller?.defaultLanguage === 'en' ? 'en' : 'th'));
    // resolve the tenant's active receipt template (presentation only); a lookup failure must never block a receipt
    let template = DEFAULT_RECEIPT_TEMPLATE;
    try { template = normalizeReceiptTemplate(await this.docTemplates.resolveActive('receipt')); } catch { /* keep default */ }
    return {
      sale_no: sale.saleNo,
      date: sale.saleDate ?? null,
      is_copy: !!opts?.isCopy,
      lang,
      seller: {
        name: seller?.name ?? 'ร้านค้า',
        legal_name: seller?.legalName ?? null,
        branch_label: seller?.branchLabelTh ?? null,
        tax_id: seller?.taxId ?? null,
        address: addr || null,
        vat_registered: !!seller?.vatRegistered,
        logo_url: seller?.logoUrl ?? null,
        tagline: seller?.tagline ?? null,
        show_logo: (seller?.brandingPrefs?.show_logo_on_receipt) !== false, // default on when a logo is set
      },
      items: lines.map((l: any) => ({ description: l.itemDescription ?? l.itemId ?? '', qty: n(l.qty), unit_price: n(l.unitPrice), amount: n(l.amount) })),
      subtotal: n(sale.subtotal),
      discount: n(sale.discount),
      vat: n(sale.taxAmount),
      total: n(sale.total),
      tip: n(sale.tip),
      payment_method: sale.paymentMethod ?? 'Cash',
      tax_invoice_no: opts?.taxInvoiceNo ?? null,
      promptpay_id: seller?.promptpayId ?? null,
      template,
    };
  }

  // Self-consistency tie-out: a receipt must reconcile to its fiscal sale record (header total = Σ line +
  // VAT − discount + tip). Drives the REST-10 control (receipt ↔ fiscal-journal tie-out).
  tieOut(d: ReceiptData) {
    const lineSum = Math.round(d.items.reduce((a, l) => a + l.amount, 0) * 100) / 100;
    const expected = Math.round((lineSum - d.discount + d.vat + d.tip) * 100) / 100;
    const matched = Math.abs(expected - Math.round((d.total + d.tip) * 100) / 100) < 0.01;
    return { sale_no: d.sale_no, line_sum: lineSum, discount: d.discount, vat: d.vat, tip: d.tip, total: d.total, matched };
  }

  // Render the HTML / ESC/POS slip through the resolved template (default applied when none is set).
  html(d: ReceiptData): string { return renderReceiptHtml(d, d.template ?? DEFAULT_RECEIPT_TEMPLATE); }
  escpos(d: ReceiptData): string { return renderReceiptEscPos(d, d.template ?? DEFAULT_RECEIPT_TEMPLATE); }
}
