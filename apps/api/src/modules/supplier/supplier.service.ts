import { Inject, Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { vendors, purchaseOrders, poItems } from '../../database/schema/procurement';
import { apTransactions } from '../../database/schema/finance';
import { DocNumberService } from '../../common/doc-number.service';
import { n, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

export interface SupplierInvoiceDto { po_no?: string; invoice_no: string; invoice_date?: string; amount: number; vat_amount?: number }

// Phase D3 — Supplier (vendor-facing) portal. The logged-in vendor is resolved from the JWT username
// and every query is scoped to that vendor's id — a supplier sees only POs/invoices for THEIR vendor
// record (RLS additionally scopes to the buying tenant).
@Injectable()
export class SupplierService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
  ) {}

  private async vendor(user: JwtUser): Promise<any> {
    const db = this.db as any;
    const [v] = await db.select().from(vendors).where(eq(vendors.userName, user.username)).limit(1);
    if (!v) throw new ForbiddenException({ code: 'VENDOR_NOT_LINKED', message: 'No vendor linked to this user', messageTh: 'บัญชีนี้ยังไม่ผูกกับผู้ขาย' });
    return v;
  }

  async myPurchaseOrders(user: JwtUser) {
    const db = this.db as any;
    const v = await this.vendor(user);
    const rows = await db.select().from(purchaseOrders).where(eq(purchaseOrders.vendorId, Number(v.id))).orderBy(desc(purchaseOrders.id)).limit(200);
    return { vendor: v.name, purchase_orders: rows.map((p: any) => ({ po_no: p.poNo, po_date: p.poDate, status: p.status, total_amount: n(p.totalAmount), expected_date: p.expectedDate, acknowledged_at: p.vendorAckAt })), count: rows.length };
  }

  async poDetail(poNo: string, user: JwtUser) {
    const db = this.db as any;
    const v = await this.vendor(user);
    const [po] = await db.select().from(purchaseOrders).where(and(eq(purchaseOrders.poNo, poNo), eq(purchaseOrders.vendorId, Number(v.id)))).limit(1);
    if (!po) throw new NotFoundException({ code: 'NOT_FOUND', message: 'PO not found', messageTh: 'ไม่พบใบสั่งซื้อ' });
    const items = await db.select().from(poItems).where(eq(poItems.poId, Number(po.id)));
    return { po_no: po.poNo, status: po.status, total_amount: n(po.totalAmount), acknowledged_at: po.vendorAckAt, items: items.map((i: any) => ({ item_id: i.itemId, description: i.itemDescription, order_qty: n(i.orderQty), unit_price: n(i.unitPrice), amount: n(i.amount), received_qty: n(i.receivedQty) })) };
  }

  async acknowledge(poNo: string, user: JwtUser) {
    const db = this.db as any;
    const v = await this.vendor(user);
    const [po] = await db.select().from(purchaseOrders).where(and(eq(purchaseOrders.poNo, poNo), eq(purchaseOrders.vendorId, Number(v.id)))).limit(1);
    if (!po) throw new NotFoundException({ code: 'NOT_FOUND', message: 'PO not found', messageTh: 'ไม่พบใบสั่งซื้อ' });
    if (po.vendorAckAt) return { po_no: poNo, acknowledged_at: po.vendorAckAt, already: true };
    const now = new Date();
    await db.update(purchaseOrders).set({ vendorAckAt: now }).where(eq(purchaseOrders.id, Number(po.id)));
    return { po_no: poNo, acknowledged_at: now };
  }

  async myInvoices(user: JwtUser) {
    const db = this.db as any;
    const v = await this.vendor(user);
    const rows = await db.select().from(apTransactions).where(eq(apTransactions.vendorId, Number(v.id))).orderBy(desc(apTransactions.id)).limit(200);
    return { invoices: rows.map((a: any) => ({ txn_no: a.txnNo, invoice_no: a.invoiceNo, ref_doc: a.refDoc, amount: n(a.amount), vat_amount: n(a.vatAmount), status: a.status, created_at: a.createdAt })), count: rows.length };
  }

  // Vendor submits an invoice → a PENDING AP transaction (Unpaid) the buyer's AP clerk then matches/pays.
  // If a po_no is given it must belong to this vendor (no submitting against someone else's PO).
  async submitInvoice(dto: SupplierInvoiceDto, user: JwtUser) {
    if (!dto.invoice_no || !(n(dto.amount) > 0)) throw new BadRequestException({ code: 'BAD_PAYLOAD', message: 'invoice_no + amount required', messageTh: 'ต้องระบุเลขที่ใบแจ้งหนี้และจำนวนเงิน' });
    const db = this.db as any;
    const v = await this.vendor(user);
    if (dto.po_no) {
      const [po] = await db.select().from(purchaseOrders).where(and(eq(purchaseOrders.poNo, dto.po_no), eq(purchaseOrders.vendorId, Number(v.id)))).limit(1);
      if (!po) throw new BadRequestException({ code: 'PO_NOT_YOURS', message: 'PO not found for this vendor', messageTh: 'ไม่พบใบสั่งซื้อของผู้ขายรายนี้' });
    }
    const txnNo = await this.docNo.nextDaily('AP');
    await db.insert(apTransactions).values({ txnNo, tenantId: v.tenantId, vendorId: Number(v.id), vendorName: v.name, txnType: 'Invoice', refDoc: dto.po_no ?? null, invoiceNo: dto.invoice_no, invoiceDate: dto.invoice_date ?? ymd(), amount: String(n(dto.amount)), vatAmount: String(n(dto.vat_amount) || 0), status: 'Unpaid', currency: v.currency ?? 'THB', createdBy: user.username });
    return { txn_no: txnNo, invoice_no: dto.invoice_no, status: 'Unpaid', amount: n(dto.amount) };
  }
}
