import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { custPosSales, custPosItems, payments, customerInventory, custStockLog, posReturns, posReturnItems, taxInvoices } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { PaymentService } from '../payments/payments.service';
import { LedgerService } from '../ledger/ledger.service';
import { n, fx, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import type { CreateReturnDto } from './dto';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

@Injectable()
export class ReturnsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly payments: PaymentService,
    private readonly ledger: LedgerService,
  ) {}

  // item-level return: refund (reuse PaymentService.refund) + restock + GL reversal, atomic.
  async createReturn(dto: CreateReturnDto, user: JwtUser) {
    const db = this.db as any;
    if (dto.refund_method === 'None') throw new BadRequestException({ code: 'STORE_CREDIT_UNSUPPORTED', message: 'Store credit not supported yet', messageTh: 'ยังไม่รองรับเครดิตร้านค้า (Tier 2)' });
    const [sale] = await db.select().from(custPosSales).where(eq(custPosSales.saleNo, dto.sale_no)).limit(1);
    if (!sale) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Sale not found', messageTh: 'ไม่พบรายการขาย' });
    // LOCK the captured payment FIRST → concurrent returns on this sale serialize, so the over-return
    // guard + refund + restock below all see each other's committed effect (no double-refund/restock).
    const [pay] = await db.select().from(payments).where(and(eq(payments.saleNo, dto.sale_no), sql`${payments.status}::text IN ('Captured','Settled','Refunded')`)).orderBy(desc(payments.id)).for('update').limit(1);
    if (!pay) throw new BadRequestException({ code: 'NO_CAPTURED_PAYMENT', message: 'No captured payment to refund', messageTh: 'คืนเงินไม่ได้: ไม่พบการชำระเงิน' });
    const saleItems = await db.select().from(custPosItems).where(eq(custPosItems.saleId, Number(sale.id)));

    // resolve each requested line to a sale line
    const resolved: any[] = [];
    for (const req of dto.items) {
      let line: any;
      if (req.sale_item_id != null) line = saleItems.find((i: any) => Number(i.id) === req.sale_item_id);
      else { const m = saleItems.filter((i: any) => String(i.itemId) === String(req.item_id)); if (m.length > 1) throw new BadRequestException({ code: 'AMBIGUOUS_LINE', message: `item_id ${req.item_id} matches multiple lines; use sale_item_id`, messageTh: 'รายการซ้ำ ระบุ sale_item_id' }); line = m[0]; }
      if (!line) throw new BadRequestException({ code: 'RETURN_LINE_NOT_FOUND', message: 'Sale line not found', messageTh: 'ไม่พบรายการสินค้าในบิล' });
      resolved.push({ line, qty: n(req.qty) });
    }

    // per-line over-return guard (prior returned qty for this sale line)
    const prior = await db.select({ saleItemId: posReturnItems.saleItemId, v: sql<string>`coalesce(sum(${posReturnItems.returnQty}),0)` })
      .from(posReturnItems).innerJoin(posReturns, eq(posReturnItems.returnId, posReturns.id))
      .where(and(eq(posReturns.saleNo, dto.sale_no), sql`${posReturns.status}::text = 'Completed'`)).groupBy(posReturnItems.saleItemId);
    const priorMap = new Map<number, number>(prior.map((p: any) => [Number(p.saleItemId), n(p.v)]));

    let subtotalReturned = 0;
    const retLines: any[] = [];
    for (const { line, qty } of resolved) {
      const sold = n(line.qty);
      const already = priorMap.get(Number(line.id)) ?? 0;
      if (already + qty > sold + 1e-9) throw new BadRequestException({ code: 'OVER_RETURN', message: `Cannot return ${qty} of ${line.itemId}; ${round2(sold - already)} remain (sold ${sold}, returned ${already})`, messageTh: 'คืนสินค้าเกินจำนวนที่ขาย' });
      const lineNet = round2(n(line.amount) * (qty / (sold || 1)));
      subtotalReturned = round2(subtotalReturned + lineNet);
      retLines.push({ line, qty, lineNet });
    }
    const vatReturned = round2(n(sale.subtotal) > 0 ? n(sale.taxAmount) * (subtotalReturned / n(sale.subtotal)) : 0);
    const totalReturned = round2(subtotalReturned + vatReturned);

    const returnNo = await this.docNo.nextDaily('RTN');
    let refundNo: string | null = null;
    if (totalReturned > 0) { const rf: any = await this.payments.refund({ payment_no: pay.paymentNo, amount: totalReturned, reason: dto.reason }, user); refundNo = rf.refund_no; }

    // restock (only for items tracked in customer_inventory) + stock log
    let restockedAny = false;
    for (const rl of retLines) {
      const [inv] = await db.select().from(customerInventory).where(and(eq(customerInventory.tenantId, sale.tenantId), eq(customerInventory.itemId, rl.line.itemId))).limit(1);
      if (inv) {
        const after = round2(n(inv.currentStock) + rl.qty);
        await db.update(customerInventory).set({ currentStock: String(after), lastUpdated: new Date() }).where(eq(customerInventory.id, inv.id));
        await db.insert(custStockLog).values({ tenantId: sale.tenantId, itemId: rl.line.itemId, itemDescription: rl.line.itemDescription, logDate: new Date(), logType: 'Return', qtyChange: String(rl.qty), balanceAfter: String(after), refDoc: returnNo, createdBy: user.username });
        rl.restocked = true; restockedAny = true;
      } else rl.restocked = false;
    }

    const [h] = await db.insert(posReturns).values({
      returnNo, tenantId: sale.tenantId, saleNo: dto.sale_no, paymentNo: pay.paymentNo, refundNo, refundMethod: dto.refund_method ?? 'Cash',
      returnDate: ymd(), reason: dto.reason ?? null, subtotalReturned: fx(subtotalReturned, 2), vatReturned: fx(vatReturned, 2), totalReturned: fx(totalReturned, 2),
      restocked: restockedAny, status: 'Completed', createdBy: user.username,
    }).returning({ id: posReturns.id });
    await db.insert(posReturnItems).values(retLines.map((rl) => ({ returnId: Number(h.id), tenantId: sale.tenantId, saleItemId: Number(rl.line.id), itemId: rl.line.itemId, itemDescription: rl.line.itemDescription, returnQty: String(rl.qty), uom: rl.line.uom, unitPrice: fx(n(rl.line.unitPrice), 2), amount: fx(rl.lineNet, 2), restocked: rl.restocked })));

    // GL reversal: Dr 4000 net + Dr 2100 vat / Cr 1000 total (zero legs auto-dropped). Idempotent per returnNo.
    let journalNo: string | null = null;
    if (totalReturned > 0 && !(await this.ledger.alreadyPosted('RTN', returnNo))) {
      const je: any = await this.ledger.postEntry({ source: 'RTN', sourceRef: returnNo, tenantId: sale.tenantId, memo: `Return ${returnNo} of ${dto.sale_no}`, createdBy: user.username, lines: [{ account_code: '4000', debit: subtotalReturned }, { account_code: '2100', debit: vatReturned }, { account_code: '1000', credit: totalReturned }] });
      journalNo = je?.entry_no ?? null;
      await db.update(posReturns).set({ journalNo }).where(eq(posReturns.id, h.id));
    }

    // credit-note (ใบลดหนี้) hook: link the original tax invoice for a future CRN issuer (Tier 2)
    const [tiv] = await db.select({ docNo: taxInvoices.docNo }).from(taxInvoices).where(and(eq(taxInvoices.sourceType, 'POS'), eq(taxInvoices.sourceRef, dto.sale_no), eq(taxInvoices.status, 'Issued'))).limit(1);
    return { return_no: returnNo, sale_no: dto.sale_no, refund_no: refundNo, subtotal_returned: subtotalReturned, vat_returned: vatReturned, total_returned: totalReturned, restocked: restockedAny, journal_no: journalNo, credit_note_no: null, original_tax_invoice_no: tiv?.docNo ?? null };
  }

  async getReturn(returnNo: string, _user: JwtUser) {
    const db = this.db as any;
    const [r] = await db.select().from(posReturns).where(eq(posReturns.returnNo, returnNo)).limit(1);
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Return not found', messageTh: 'ไม่พบรายการคืน' });
    const items = await db.select().from(posReturnItems).where(eq(posReturnItems.returnId, Number(r.id)));
    return { ...shape(r), items: items.map((i: any) => ({ item_id: i.itemId, name: i.itemDescription, qty: n(i.returnQty), amount: n(i.amount), restocked: i.restocked })) };
  }

  async listReturnsForSale(saleNo: string, _user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(posReturns).where(eq(posReturns.saleNo, saleNo)).orderBy(desc(posReturns.id));
    return { sale_no: saleNo, returns: rows.map(shape), count: rows.length };
  }
}

function shape(r: any) {
  return { return_no: r.returnNo, sale_no: r.saleNo, refund_no: r.refundNo, refund_method: r.refundMethod, subtotal_returned: n(r.subtotalReturned), vat_returned: n(r.vatReturned), total_returned: n(r.totalReturned), restocked: r.restocked, journal_no: r.journalNo, credit_note_no: r.creditNoteNo, status: r.status, return_date: r.returnDate };
}
