import { Inject, Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { rfqs, rfqItems, supplierQuotes, supplierQuoteItems, vendors } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { ymd, n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { ProcurementService } from '../procurement/procurement.service';

// RFQ → supplier quotes → award → PO. Award delegates to ProcurementService.createPo (no GL duplication;
// GL begins downstream at the GR-driven AP invoice). Supplier screening blocks quotes from blocked vendors.
@Injectable()
export class RfqService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, private readonly docNo: DocNumberService, private readonly procurement: ProcurementService) {}

  async createRfq(dto: { items: { item_id: string; item_description?: string; qty: number; uom?: string }[]; required_date?: string; remarks?: string }, user: JwtUser) {
    const db = this.db as any;
    if (!dto.items?.length) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'No items', messageTh: 'ไม่มีรายการ' });
    const rfqNo = await this.docNo.nextDaily('RFQ');
    const [h] = await db.insert(rfqs).values({ tenantId: user.tenantId ?? null, rfqNo, rfqDate: ymd(), status: 'Open', requiredDate: dto.required_date ?? null, remarks: dto.remarks ?? null, createdBy: user.username }).returning({ id: rfqs.id });
    await db.insert(rfqItems).values(dto.items.map((it) => ({ rfqId: Number(h.id), itemId: it.item_id, itemDescription: it.item_description ?? null, qty: String(n(it.qty)), uom: it.uom ?? null })));
    return { rfq_no: rfqNo, status: 'Open', lines: dto.items.length };
  }

  async submitQuote(rfqNo: string, dto: { vendor_id?: number; vendor_name?: string; items: { item_id: string; item_description?: string; qty: number; unit_price: number; uom?: string }[]; valid_until?: string; lead_time_days?: number }, user: JwtUser) {
    const db = this.db as any;
    const [rfq] = await db.select().from(rfqs).where(eq(rfqs.rfqNo, rfqNo)).limit(1);
    if (!rfq) throw new NotFoundException({ code: 'NOT_FOUND', message: 'RFQ not found', messageTh: 'ไม่พบ RFQ' });
    if (rfq.status !== 'Open') throw new ConflictException({ code: 'RFQ_CLOSED', message: 'RFQ is not open', messageTh: 'RFQ ปิดแล้ว' });
    let vendorId = dto.vendor_id ?? null, vendorName = dto.vendor_name ?? null;
    if (!vendorId && vendorName) { const [v] = await db.select().from(vendors).where(eq(vendors.name, vendorName)).limit(1); vendorId = v?.id ?? null; }
    else if (vendorId && !vendorName) { const [v] = await db.select().from(vendors).where(eq(vendors.id, vendorId)).limit(1); vendorName = v?.name ?? null; }
    await this.procurement.assertSupplierAllowed(vendorId, vendorName); // blocked vendor → 422
    const total = dto.items.reduce((a, it) => a + n(it.qty) * n(it.unit_price), 0);
    const quoteNo = await this.docNo.nextDaily('QTE');
    const [q] = await db.insert(supplierQuotes).values({ tenantId: user.tenantId ?? null, quoteNo, rfqId: Number(rfq.id), vendorId, vendorName, quoteDate: ymd(), validUntil: dto.valid_until ?? null, leadTimeDays: dto.lead_time_days ?? null, totalAmount: String(total), status: 'Submitted', createdBy: user.username }).returning({ id: supplierQuotes.id });
    await db.insert(supplierQuoteItems).values(dto.items.map((it) => ({ quoteId: Number(q.id), itemId: it.item_id, itemDescription: it.item_description ?? null, qty: String(n(it.qty)), unitPrice: String(n(it.unit_price)), uom: it.uom ?? null })));
    return { quote_no: quoteNo, rfq_no: rfqNo, total_amount: total, status: 'Submitted' };
  }

  async award(rfqNo: string, quoteNo: string, user: JwtUser) {
    const db = this.db as any;
    const [rfq] = await db.select().from(rfqs).where(eq(rfqs.rfqNo, rfqNo)).limit(1);
    if (!rfq) throw new NotFoundException({ code: 'NOT_FOUND', message: 'RFQ not found', messageTh: 'ไม่พบ RFQ' });
    if (rfq.status !== 'Open') throw new ConflictException({ code: 'RFQ_CLOSED', message: 'RFQ already awarded/closed', messageTh: 'RFQ ปิดแล้ว' });
    const [q] = await db.select().from(supplierQuotes).where(and(eq(supplierQuotes.quoteNo, quoteNo), eq(supplierQuotes.rfqId, Number(rfq.id)))).limit(1);
    if (!q) throw new NotFoundException({ code: 'QUOTE_NOT_FOUND', message: 'Quote not found for this RFQ', messageTh: 'ไม่พบใบเสนอราคา' });
    const items = await db.select().from(supplierQuoteItems).where(eq(supplierQuoteItems.quoteId, Number(q.id)));
    // build a PO from the winning quote (reuse ProcurementService.createPo — no GL here)
    const po: any = await this.procurement.createPo({ vendor_id: q.vendorId ?? undefined, vendor_name: q.vendorName ?? undefined, remarks: `Awarded from ${rfqNo}/${quoteNo}`, items: items.map((it: any) => ({ item_id: it.itemId, item_description: it.itemDescription, order_qty: n(it.qty), unit_price: n(it.unitPrice), uom: it.uom })) }, user);
    await db.update(supplierQuotes).set({ status: 'Awarded' }).where(eq(supplierQuotes.id, q.id));
    await db.update(rfqs).set({ status: 'Awarded', awardedQuoteId: Number(q.id) }).where(eq(rfqs.id, rfq.id));
    return { rfq_no: rfqNo, quote_no: quoteNo, po_no: po.po_no };
  }

  async listRfqs(_user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(rfqs).orderBy(desc(rfqs.id)).limit(100);
    return { rfqs: rows.map((r: any) => ({ rfq_no: r.rfqNo, status: r.status, rfq_date: r.rfqDate, required_date: r.requiredDate })) };
  }
  async getRfq(rfqNo: string, _user: JwtUser) {
    const db = this.db as any;
    const [r] = await db.select().from(rfqs).where(eq(rfqs.rfqNo, rfqNo)).limit(1);
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'RFQ not found', messageTh: 'ไม่พบ RFQ' });
    const items = await db.select().from(rfqItems).where(eq(rfqItems.rfqId, Number(r.id)));
    const quotes = await db.select().from(supplierQuotes).where(eq(supplierQuotes.rfqId, Number(r.id)));
    return { rfq_no: r.rfqNo, status: r.status, items: items.map((i: any) => ({ item_id: i.itemId, qty: n(i.qty) })), quotes: quotes.map((q: any) => ({ quote_no: q.quoteNo, vendor_name: q.vendorName, total_amount: n(q.totalAmount), status: q.status })) };
  }
}
