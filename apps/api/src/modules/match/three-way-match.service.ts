import { Inject, Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { apTransactions, purchaseOrders, poItems, invoiceMatchResults, invoiceMatchLines, matchTolerance } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { StatusLogService } from '../../common/status-log.service';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const r3 = (x: number) => Math.round((Number(x) || 0) * 1000) / 1000;
const PRICE_FLOOR = 0.005; // half-cent rounding floor on unit-price comparison
// worst-of priority — the header takes the most severe line status
const SEVERITY = ['matched', 'price_variance', 'over_invoiced', 'qty_variance', 'unmatched'];

export interface MatchLineInput { item_id: string; qty: number; unit_price: number }

// 3-way match: reconcile a supplier invoice (AP txn) against its PO (price) and GR (received qty), within
// configurable tolerance, and GATE the AP payment. Posts NO GL — the AP invoice/payment GL is unchanged.
@Injectable()
export class ThreeWayMatchService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, private readonly docNo: DocNumberService, private readonly statusLog: StatusLogService) {}

  async getTolerance(): Promise<{ qtyPct: number; pricePct: number; amountPct: number; amountAbs: number }> {
    const db = this.db as any;
    const [t] = await db.select().from(matchTolerance).limit(1);
    return { qtyPct: n(t?.qtyPct ?? 0), pricePct: t ? n(t.pricePct) : 2, amountPct: t ? n(t.amountPct) : 2, amountAbs: t ? n(t.amountAbs) : 0.5 };
  }
  async setTolerance(dto: { qty_pct?: number; price_pct?: number; amount_pct?: number; amount_abs?: number }, user: JwtUser) {
    const db = this.db as any;
    const [ex] = await db.select().from(matchTolerance).limit(1);
    const cur = await this.getTolerance();
    const vals = { qtyPct: String(dto.qty_pct ?? cur.qtyPct), pricePct: String(dto.price_pct ?? cur.pricePct), amountPct: String(dto.amount_pct ?? cur.amountPct), amountAbs: String(dto.amount_abs ?? cur.amountAbs), updatedBy: user.username };
    if (ex) await db.update(matchTolerance).set(vals).where(eq(matchTolerance.id, ex.id));
    else await db.insert(matchTolerance).values({ tenantId: user.tenantId ?? null, ...vals });
    return this.getTolerance();
  }

  // Run the match for an AP invoice against a PO. Idempotent on txn_no (re-match overwrites header + lines).
  async match(txnNo: string, poNo: string | undefined, lines: MatchLineInput[] | undefined, user: JwtUser) {
    const db = this.db as any;
    const [tx] = await db.select().from(apTransactions).where(eq(apTransactions.txnNo, txnNo)).limit(1);
    if (!tx) throw new NotFoundException({ code: 'NOT_FOUND', message: 'AP txn not found', messageTh: 'ไม่พบรายการ AP' });
    if (!poNo) throw new BadRequestException({ code: 'PO_REQUIRED', message: 'po_no is required for matching', messageTh: 'ต้องระบุเลข PO' });
    const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.poNo, poNo)).limit(1);
    if (!po) throw new NotFoundException({ code: 'PO_NOT_FOUND', message: `PO ${poNo} not found`, messageTh: 'ไม่พบ PO' });
    const poLines = await db.select().from(poItems).where(eq(poItems.poId, Number(po.id)));
    const byItem = new Map<string, any>(poLines.map((l: any) => [String(l.itemId), l]));
    const tol = await this.getTolerance();

    // fall back to a single header line (invoice amount vs PO total) when no lines are supplied
    const inputLines: MatchLineInput[] = lines?.length ? lines : [{ item_id: '__TOTAL__', qty: 1, unit_price: n(tx.amount) }];
    const resultLines: any[] = [];
    for (const il of inputLines) {
      const po = byItem.get(String(il.item_id));
      let status = 'matched'; let poQty = 0, poPrice = 0, grQty = 0, priceVar = 0, qtyVar = 0;
      if (!po) status = 'unmatched';
      else {
        poQty = n(po.orderQty); poPrice = n(po.unitPrice); grQty = n(po.receivedQty);
        priceVar = poPrice > 0 ? r3(Math.abs(n(il.unit_price) - poPrice) / poPrice * 100) : (n(il.unit_price) > 0 ? 100 : 0);
        qtyVar = grQty > 0 ? r3(Math.abs(n(il.qty) - grQty) / grQty * 100) : (n(il.qty) > 0 ? 100 : 0);
        // over-receipt: invoiced more than was received (beyond qty tolerance)
        if (n(il.qty) - grQty > grQty * tol.qtyPct / 100 + 1e-9) status = 'over_invoiced';
        else if (Math.abs(n(il.unit_price) - poPrice) > Math.max(poPrice * tol.pricePct / 100, PRICE_FLOOR)) status = 'price_variance';
        else status = 'matched';
      }
      resultLines.push({ itemId: il.item_id, invQty: String(n(il.qty)), invPrice: String(n(il.unit_price)), poQty: String(poQty), poPrice: String(poPrice), grQty: String(grQty), qtyVarPct: String(qtyVar), priceVarPct: String(priceVar), lineStatus: status });
    }
    const headerStatus = resultLines.reduce((worst, l) => (SEVERITY.indexOf(l.lineStatus) > SEVERITY.indexOf(worst) ? l.lineStatus : worst), 'matched');
    const payable = headerStatus === 'matched';

    // upsert header by txn_no (preserve override on re-match? no — a fresh match resets the verdict)
    const [existing] = await db.select().from(invoiceMatchResults).where(eq(invoiceMatchResults.txnNo, txnNo)).limit(1);
    let matchNo: string; let matchId: number;
    if (existing) {
      matchNo = existing.matchNo; matchId = Number(existing.id);
      await db.update(invoiceMatchResults).set({ poNo, matchStatus: headerStatus, payable, matchedBy: user.username, matchedAt: new Date() }).where(eq(invoiceMatchResults.id, matchId));
      await db.delete(invoiceMatchLines).where(eq(invoiceMatchLines.matchId, matchId));
    } else {
      matchNo = await this.docNo.nextDaily('MAT');
      const [h] = await db.insert(invoiceMatchResults).values({ tenantId: tx.tenantId ?? user.tenantId ?? null, matchNo, txnNo, poNo, matchStatus: headerStatus, payable, matchedBy: user.username }).returning({ id: invoiceMatchResults.id });
      matchId = Number(h.id);
    }
    await db.insert(invoiceMatchLines).values(resultLines.map((l) => ({ matchId, ...l })));
    await this.statusLog.log('MATCH', matchNo, '', headerStatus, user.username);
    return { match_no: matchNo, txn_no: txnNo, po_no: poNo, match_status: headerStatus, payable, lines: resultLines.map((l) => ({ item_id: l.itemId, inv_qty: n(l.invQty), inv_price: n(l.invPrice), po_price: n(l.poPrice), gr_qty: n(l.grQty), price_var_pct: n(l.priceVarPct), qty_var_pct: n(l.qtyVarPct), line_status: l.lineStatus })) };
  }

  // Payment gate — called from FinanceService.payAp.
  async assertPayable(txnNo: string) {
    const db = this.db as any;
    const [m] = await db.select().from(invoiceMatchResults).where(eq(invoiceMatchResults.txnNo, txnNo)).limit(1);
    if (!m) throw new ConflictException({ code: 'MATCH_REQUIRED', message: `Invoice ${txnNo} must pass 3-way match before payment`, messageTh: 'ต้องผ่านการจับคู่ 3 ทางก่อนจ่าย' });
    if (m.payable || m.override) return;
    throw new ConflictException({ code: 'MATCH_BLOCKED', message: `Invoice ${txnNo} blocked: ${m.matchStatus}`, messageTh: `ใบแจ้งหนี้ถูกระงับ (${m.matchStatus})`, match_status: m.matchStatus } as any);
  }

  async override(txnNo: string, reason: string, user: JwtUser) {
    const db = this.db as any;
    const [m] = await db.select().from(invoiceMatchResults).where(eq(invoiceMatchResults.txnNo, txnNo)).limit(1);
    if (!m) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No match to override', messageTh: 'ไม่พบการจับคู่' });
    await db.update(invoiceMatchResults).set({ override: true, overrideBy: user.username, overrideReason: reason ?? null, overrideAt: new Date() }).where(eq(invoiceMatchResults.id, m.id));
    await this.statusLog.log('MATCH', m.matchNo, m.matchStatus, 'Override', user.username);
    return { txn_no: txnNo, match_status: m.matchStatus, payable: m.payable, override: true };
  }

  async getMatch(txnNo: string) {
    const db = this.db as any;
    const [m] = await db.select().from(invoiceMatchResults).where(eq(invoiceMatchResults.txnNo, txnNo)).limit(1);
    if (!m) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No match for this invoice', messageTh: 'ไม่พบการจับคู่' });
    const lines = await db.select().from(invoiceMatchLines).where(eq(invoiceMatchLines.matchId, Number(m.id)));
    return { match_no: m.matchNo, txn_no: m.txnNo, po_no: m.poNo, match_status: m.matchStatus, payable: m.payable, override: m.override, override_reason: m.overrideReason, lines: lines.map((l: any) => ({ item_id: l.itemId, inv_qty: n(l.invQty), inv_price: n(l.invPrice), po_price: n(l.poPrice), gr_qty: n(l.grQty), price_var_pct: n(l.priceVarPct), qty_var_pct: n(l.qtyVarPct), line_status: l.lineStatus })) };
  }
}
