import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc, sql, gte, lte, like, or } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { custPosSales, custPosItems, payments, customerInventory, custStockLog, branchStock, posReturns, posReturnItems, taxInvoices } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { PaymentService } from '../payments/payments.service';
import { LedgerService } from '../ledger/ledger.service';
import { RecipeService } from '../menu/recipe.service';
import { GiftCardService } from '../giftcards/gift-card.service';
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
    private readonly recipe: RecipeService,
    private readonly gift: GiftCardService,
  ) {}

  // item-level return: refund (reuse PaymentService.refund) + restock + GL reversal — ATOMIC.
  // The whole flow runs in ONE transaction: the FOR UPDATE lock on the captured payment is held to
  // commit (so concurrent returns on the same sale truly serialize), and refund + restock + return
  // record + GL reversal either all commit or all roll back — no money refunded without a return on
  // file, no restock without a record. Refund/store-credit/COGS reversal all run on the same tx.
  async createReturn(dto: CreateReturnDto, user: JwtUser) {
    if (dto.refund_method === 'None') throw new BadRequestException({ code: 'REFUND_METHOD_REQUIRED', message: 'Choose a refund method (Cash/Card/StoreCredit…)', messageTh: 'กรุณาเลือกวิธีคืนเงิน' });
    const isStoreCredit = dto.refund_method === 'StoreCredit';

    return await (this.db as any).transaction(async (tx: any) => {
      const [sale] = await tx.select().from(custPosSales).where(eq(custPosSales.saleNo, dto.sale_no)).limit(1);
      if (!sale) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Sale not found', messageTh: 'ไม่พบรายการขาย' });
      // LOCK the captured payment FIRST → held to commit, so concurrent returns on this sale serialize and
      // the over-return guard + refund + restock below all see each other's committed effect.
      const [pay] = await tx.select().from(payments).where(and(eq(payments.saleNo, dto.sale_no), sql`${payments.status}::text IN ('Captured','Settled','Refunded')`)).orderBy(desc(payments.id)).for('update').limit(1);
      if (!pay) throw new BadRequestException({ code: 'NO_CAPTURED_PAYMENT', message: 'No captured payment to refund', messageTh: 'คืนเงินไม่ได้: ไม่พบการชำระเงิน' });
      const saleItems = await tx.select().from(custPosItems).where(eq(custPosItems.saleId, Number(sale.id)));

      // resolve each requested line to a sale line
      const resolved: any[] = [];
      for (const req of dto.items) {
        let line: any;
        if (req.sale_item_id != null) line = saleItems.find((i: any) => Number(i.id) === req.sale_item_id);
        else { const m = saleItems.filter((i: any) => String(i.itemId) === String(req.item_id)); if (m.length > 1) throw new BadRequestException({ code: 'AMBIGUOUS_LINE', message: `item_id ${req.item_id} matches multiple lines; use sale_item_id`, messageTh: 'รายการซ้ำ ระบุ sale_item_id' }); line = m[0]; }
        if (!line) throw new BadRequestException({ code: 'RETURN_LINE_NOT_FOUND', message: 'Sale line not found', messageTh: 'ไม่พบรายการสินค้าในบิล' });
        resolved.push({ line, qty: n(req.qty) });
      }

      // per-line over-return guard (prior returned qty for this sale line) — read under the payment lock
      const prior = await tx.select({ saleItemId: posReturnItems.saleItemId, v: sql<string>`coalesce(sum(${posReturnItems.returnQty}),0)` })
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
      // refund path: cash/card returns money via PaymentService.refund (Cr 1000); store credit issues a gift
      // card (Cr 2200) and pays out NO cash — refundNo stays null, the card_no carries the credit.
      // Both run on THIS tx so they roll back with the return on any later failure.
      let refundNo: string | null = null;
      let storeCreditCardNo: string | null = null;
      if (totalReturned > 0) {
        if (isStoreCredit) { const gc = await this.gift.creditFromReturn(totalReturned, sale.tenantId, returnNo, user, dto.gift_card_no, tx); storeCreditCardNo = gc.card_no; }
        else { const rf: any = await this.payments.refund({ payment_no: pay.paymentNo, amount: totalReturned, reason: dto.reason }, user, tx); refundNo = rf.refund_no; }
      }

      // restock (only for items tracked in customer_inventory) + stock log
      let restockedAny = false;
      for (const rl of retLines) {
        // Lock the inventory row (matches the deduction path in recipe.service.applyDeduction): a restock-add
        // on a row another concurrent movement is also touching must not lose its increment.
        const [inv] = await tx.select().from(customerInventory).where(and(eq(customerInventory.tenantId, sale.tenantId), eq(customerInventory.itemId, rl.line.itemId))).for('update').limit(1);
        if (inv) {
          const after = round2(n(inv.currentStock) + rl.qty);
          await tx.update(customerInventory).set({ currentStock: String(after), lastUpdated: new Date() }).where(eq(customerInventory.id, inv.id));
          await tx.insert(custStockLog).values({ tenantId: sale.tenantId, branchId: sale.branchId, itemId: rl.line.itemId, itemDescription: rl.line.itemDescription, logDate: new Date(), logType: 'Return', qtyChange: String(rl.qty), balanceAfter: String(after), refDoc: returnNo, createdBy: user.username });
          // mirror the restock into the per-branch ledger (credit the sale's branch). Lock order: rollup → branch.
          if (sale.branchId != null) {
            const [bs] = await tx.select().from(branchStock).where(and(eq(branchStock.tenantId, sale.tenantId), eq(branchStock.branchId, sale.branchId), eq(branchStock.itemId, rl.line.itemId))).for('update').limit(1);
            if (bs) await tx.update(branchStock).set({ onHand: String(round2(n(bs.onHand) + rl.qty)), lastUpdated: new Date() }).where(eq(branchStock.id, bs.id));
            else await tx.insert(branchStock).values({ tenantId: sale.tenantId, branchId: sale.branchId, itemId: rl.line.itemId, itemDescription: rl.line.itemDescription, uom: rl.line.uom ?? null, onHand: String(round2(rl.qty)), lastUpdated: new Date() });
          }
          rl.restocked = true; restockedAny = true;
        } else rl.restocked = false;
      }

      const [h] = await tx.insert(posReturns).values({
        returnNo, tenantId: sale.tenantId, saleNo: dto.sale_no, paymentNo: pay.paymentNo, refundNo, refundMethod: dto.refund_method ?? 'Cash',
        returnDate: ymd(), reason: dto.reason ?? null, subtotalReturned: fx(subtotalReturned, 2), vatReturned: fx(vatReturned, 2), totalReturned: fx(totalReturned, 2),
        restocked: restockedAny, status: 'Completed', createdBy: user.username,
      }).returning({ id: posReturns.id });
      await tx.insert(posReturnItems).values(retLines.map((rl) => ({ returnId: Number(h.id), tenantId: sale.tenantId, saleItemId: Number(rl.line.id), itemId: rl.line.itemId, itemDescription: rl.line.itemDescription, returnQty: String(rl.qty), uom: rl.line.uom, unitPrice: fx(n(rl.line.unitPrice), 2), amount: fx(rl.lineNet, 2), restocked: rl.restocked })));

      // GL reversal: Dr 4000 net + Dr 2100 vat / Cr (1000 cash | 2200 store credit) total (zero legs
      // auto-dropped). Store credit credits the deposit liability instead of paying cash out. Idempotent,
      // and posted on THIS tx so the GL reversal commits/rolls back with the return.
      let journalNo: string | null = null;
      if (totalReturned > 0 && !(await this.ledger.alreadyPosted('RTN', returnNo, sale.tenantId, tx))) {
        const creditLeg = isStoreCredit ? '2200' : '1000';
        const je: any = await this.ledger.postEntry({ source: 'RTN', sourceRef: returnNo, tenantId: sale.tenantId, memo: `Return ${returnNo} of ${dto.sale_no}`, createdBy: user.username, lines: [{ account_code: '4000', debit: subtotalReturned }, { account_code: '2100', debit: vatReturned }, { account_code: creditLeg, credit: totalReturned }] }, tx);
        journalNo = je?.entry_no ?? null;
        await tx.update(posReturns).set({ journalNo }).where(eq(posReturns.id, h.id));
      }

      // recipe/BOM: reverse ingredient deduction (restore stock) + COGS reversal Dr 1200 / Cr 5300
      let cogsRev = 0;
      for (const rl of retLines) { const rev = await this.recipe.reverseDeduction(tx, sale.tenantId, String(rl.line.itemId ?? ''), rl.qty, returnNo, user, sale.branchId); cogsRev = round2(cogsRev + rev.cost); }
      if (cogsRev > 0 && !(await this.ledger.alreadyPosted('RTN-COGS', returnNo, sale.tenantId, tx))) {
        await this.ledger.postEntry({ source: 'RTN-COGS', sourceRef: returnNo, tenantId: sale.tenantId, memo: `COGS reversal ${returnNo}`, createdBy: user.username, lines: [{ account_code: '1200', debit: cogsRev }, { account_code: '5300', credit: cogsRev }] }, tx);
      }

      // credit-note (ใบลดหนี้) hook: link the original tax invoice for a future CRN issuer (Tier 2)
      const [tiv] = await tx.select({ docNo: taxInvoices.docNo }).from(taxInvoices).where(and(eq(taxInvoices.sourceType, 'POS'), eq(taxInvoices.sourceRef, dto.sale_no), eq(taxInvoices.status, 'Issued'))).limit(1);
      return { return_no: returnNo, sale_no: dto.sale_no, refund_no: refundNo, refund_method: dto.refund_method ?? 'Cash', store_credit_card_no: storeCreditCardNo, subtotal_returned: subtotalReturned, vat_returned: vatReturned, total_returned: totalReturned, restocked: restockedAny, journal_no: journalNo, credit_note_no: null, original_tax_invoice_no: tiv?.docNo ?? null };
    });
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

  // Returns register — every return for the caller's tenant (ops / finance / audit view), filterable by
  // date / status / refund method / free-text. Tenant-scoped EXPLICITLY (an HQ/Admin request bypasses RLS,
  // so an unfiltered list would leak another store's returns). Typed builders only (no raw SQL at user input).
  async listAll(q: { from?: string; to?: string; status?: string; method?: string; search?: string; limit?: number; offset?: number }, user: JwtUser) {
    const db = this.db as any;
    const conds: any[] = [];
    if (user.tenantId != null) conds.push(eq(posReturns.tenantId, user.tenantId));
    if (q.from) conds.push(gte(posReturns.returnDate, q.from));
    if (q.to) conds.push(lte(posReturns.returnDate, q.to));
    if (q.status) conds.push(eq(posReturns.status, q.status));
    if (q.method) conds.push(eq(posReturns.refundMethod, q.method));
    if (q.search) conds.push(or(like(posReturns.returnNo, `%${q.search}%`), like(posReturns.saleNo, `%${q.search}%`))!);
    const where = conds.length ? and(...conds) : undefined;
    const rows = await db.select().from(posReturns).where(where).orderBy(desc(posReturns.id)).limit(q.limit ?? 50).offset(q.offset ?? 0);
    const [agg] = await db.select({
      cnt: sql<string>`count(*)`,
      total: sql<string>`coalesce(sum(${posReturns.totalReturned}),0)`,
      restocked: sql<string>`coalesce(sum(case when ${posReturns.restocked} then 1 else 0 end),0)`,
    }).from(posReturns).where(where);
    return { returns: rows.map(shape), count: rows.length, total_count: n(agg?.cnt), total_refunded: round2(n(agg?.total)), restocked_count: n(agg?.restocked) };
  }
}

function shape(r: any) {
  return { return_no: r.returnNo, sale_no: r.saleNo, refund_no: r.refundNo, refund_method: r.refundMethod, subtotal_returned: n(r.subtotalReturned), vat_returned: n(r.vatReturned), total_returned: n(r.totalReturned), restocked: r.restocked, journal_no: r.journalNo, credit_note_no: r.creditNoteNo, status: r.status, return_date: r.returnDate };
}
