import { Inject, Injectable, BadRequestException, NotFoundException, ConflictException, ForbiddenException } from '@nestjs/common';
import { eq, and, ne, isNull, or, like, desc, sql } from 'drizzle-orm';
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

  // tenant-scoped read — never rely on RLS+limit(1) (an Admin/HQ request bypasses RLS, so an unfiltered
  // limit(1) could return another tenant's tolerance and flip the payable verdict).
  async getTolerance(tenantId?: number | null): Promise<{ qtyPct: number; pricePct: number; amountPct: number; amountAbs: number }> {
    const db = this.db;
    const [t] = tenantId != null
      ? await db.select().from(matchTolerance).where(eq(matchTolerance.tenantId, tenantId)).limit(1)
      : await db.select().from(matchTolerance).where(isNull(matchTolerance.tenantId)).limit(1);
    return { qtyPct: n(t?.qtyPct ?? 0), pricePct: t ? n(t.pricePct) : 2, amountPct: t ? n(t.amountPct) : 2, amountAbs: t ? n(t.amountAbs) : 0.5 };
  }
  async setTolerance(dto: { qty_pct?: number; price_pct?: number; amount_pct?: number; amount_abs?: number }, user: JwtUser) {
    const db = this.db;
    const [ex] = await db.select().from(matchTolerance).where(user.tenantId != null ? eq(matchTolerance.tenantId, user.tenantId) : isNull(matchTolerance.tenantId)).limit(1);
    const cur = await this.getTolerance(user.tenantId ?? null);
    const vals = { qtyPct: String(dto.qty_pct ?? cur.qtyPct), pricePct: String(dto.price_pct ?? cur.pricePct), amountPct: String(dto.amount_pct ?? cur.amountPct), amountAbs: String(dto.amount_abs ?? cur.amountAbs), updatedBy: user.username };
    if (ex) await db.update(matchTolerance).set(vals).where(eq(matchTolerance.id, ex.id));
    else await db.insert(matchTolerance).values({ tenantId: user.tenantId ?? null, ...vals });
    return this.getTolerance();
  }

  // Run the match for an AP invoice against a PO. Idempotent on txn_no (re-match overwrites header + lines).
  async match(txnNo: string, poNo: string | undefined, lines: MatchLineInput[] | undefined, user: JwtUser) {
    const db = this.db;
    const [tx] = await db.select().from(apTransactions).where(eq(apTransactions.txnNo, txnNo)).limit(1);
    if (!tx) throw new NotFoundException({ code: 'NOT_FOUND', message: 'AP txn not found', messageTh: 'ไม่พบรายการ AP' });
    if (!poNo) throw new BadRequestException({ code: 'PO_REQUIRED', message: 'po_no is required for matching', messageTh: 'ต้องระบุเลข PO' });
    const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.poNo, poNo)).limit(1);
    if (!po) throw new NotFoundException({ code: 'PO_NOT_FOUND', message: `PO ${poNo} not found`, messageTh: 'ไม่พบ PO' });
    const poLines = await db.select().from(poItems).where(eq(poItems.poId, Number(po.id)));
    const byItem = new Map<string, any>(poLines.map((l: any) => [String(l.itemId), l]));
    const tol = await this.getTolerance(tx.tenantId ?? user.tenantId ?? null);

    const resultLines: any[] = [];
    if (!lines?.length) {
      // Header-level amount match (no invoice lines — e.g. a scanned-total AP intake, EXP-10): compare the
      // invoice amount against the RECEIVED value on the PO (Σ received_qty × unit_price) within the amount
      // tolerance (amount_pct/amount_abs — stored since Phase 16, previously unused), on the same price
      // basis as the PO. Invoicing beyond received value is over_invoiced (blocked until the GR catches up
      // or a checker overrides); billing at/below the remaining value is matched — partial billing
      // carries no pay-for-goods-not-received risk. The row stores the VALUE comparison in the qty
      // columns (inv=invoice total, po=ordered value, gr=remaining un-invoiced received value), price 1.
      const invAmt = n(tx.amount);
      const receivedValue = r3(poLines.reduce((s: number, l: any) => s + n(l.receivedQty) * n(l.unitPrice), 0));
      const orderedValue = r3(poLines.reduce((s: number, l: any) => s + (l.amount != null ? n(l.amount) : n(l.orderQty) * n(l.unitPrice)), 0));
      // Cumulative guard: every OTHER invoice already matched to this PO consumes its received value —
      // a second header invoice can only bill what remains (stops double-billing one PO under two
      // invoice numbers). Blocked invoices count too (conservative: both could later be released).
      const prior = await db.select({ amt: apTransactions.amount }).from(invoiceMatchResults)
        .innerJoin(apTransactions, eq(invoiceMatchResults.txnNo, apTransactions.txnNo))
        .where(and(eq(invoiceMatchResults.poNo, poNo), ne(invoiceMatchResults.txnNo, txnNo)));
      const available = r3(receivedValue - prior.reduce((s: number, p: any) => s + n(p.amt), 0));
      const tolAmt = Math.max(receivedValue * tol.amountPct / 100, tol.amountAbs);
      const status = invAmt - available > tolAmt + 1e-9 ? 'over_invoiced' : 'matched';
      const varPct = available > 0 ? r3(Math.abs(invAmt - available) / available * 100) : (invAmt > 0 ? 100 : 0);
      resultLines.push({ itemId: '__TOTAL__', invQty: String(invAmt), invPrice: '1', poQty: String(orderedValue), poPrice: '1', grQty: String(available), qtyVarPct: String(varPct), priceVarPct: '0', lineStatus: status });
    }
    const inputLines: MatchLineInput[] = lines?.length ? lines : [];
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

    // upsert header by txn_no. A fresh match RESETS the verdict INCLUDING any prior human override — a
    // stale one-time override must not keep a now-failing invoice payable.
    let [existing] = await db.select().from(invoiceMatchResults).where(eq(invoiceMatchResults.txnNo, txnNo)).limit(1);
    let matchNo = ''; let matchId = 0;
    if (!existing) {
      matchNo = await this.docNo.nextDaily('MAT');
      const ins = await db.insert(invoiceMatchResults).values({ tenantId: tx.tenantId ?? user.tenantId ?? null, matchNo, txnNo, poNo, matchStatus: headerStatus, payable, matchedBy: user.username })
        .onConflictDoNothing({ target: invoiceMatchResults.txnNo }).returning({ id: invoiceMatchResults.id });
      if (ins.length) matchId = Number(ins[0]!.id);
      else { [existing] = await db.select().from(invoiceMatchResults).where(eq(invoiceMatchResults.txnNo, txnNo)).limit(1); } // concurrent first-match won
    }
    if (existing) {
      matchNo = existing.matchNo; matchId = Number(existing.id);
      await db.update(invoiceMatchResults).set({ poNo, matchStatus: headerStatus, payable, override: false, overrideBy: null, overrideReason: null, overrideAt: null, matchedBy: user.username, matchedAt: new Date() }).where(eq(invoiceMatchResults.id, matchId));
      await db.delete(invoiceMatchLines).where(eq(invoiceMatchLines.matchId, matchId));
    }
    await db.insert(invoiceMatchLines).values(resultLines.map((l) => ({ matchId, ...l })));
    await this.statusLog.log('MATCH', matchNo, '', headerStatus, user.username);
    return { match_no: matchNo, txn_no: txnNo, po_no: poNo, match_status: headerStatus, payable, lines: resultLines.map((l) => ({ item_id: l.itemId, inv_qty: n(l.invQty), inv_price: n(l.invPrice), po_price: n(l.poPrice), gr_qty: n(l.grQty), price_var_pct: n(l.priceVarPct), qty_var_pct: n(l.qtyVarPct), line_status: l.lineStatus })) };
  }

  // Payment gate — called from FinanceService.payAp. Fail-OPEN when no match row exists: a non-PO bill
  // (utilities/services/reimbursements) is never matched and must remain payable. The gate only BLOCKS a
  // PO-based invoice that was run through match() and did not pass (or was overridden).
  async assertPayable(txnNo: string) {
    const db = this.db;
    const [m] = await db.select().from(invoiceMatchResults).where(eq(invoiceMatchResults.txnNo, txnNo)).limit(1);
    if (!m) return; // non-PO bill — not subject to the 3-way gate
    if (m.payable || m.override) return;
    throw new ConflictException({ code: 'MATCH_BLOCKED', message: `Invoice ${txnNo} blocked: ${m.matchStatus}`, messageTh: `ใบแจ้งหนี้ถูกระงับ (${m.matchStatus})`, match_status: m.matchStatus } as any);
  }

  // EXP-01 override is maker-checked: the person who RAN the match cannot also override its variance to force the
  // invoice payable — a different user must. Binds even Admin (no self-override). Mirrors GL-05/INV-07 SoD.
  async override(txnNo: string, reason: string, user: JwtUser) {
    const db = this.db;
    const [m] = await db.select().from(invoiceMatchResults).where(eq(invoiceMatchResults.txnNo, txnNo)).limit(1);
    if (!m) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No match to override', messageTh: 'ไม่พบการจับคู่' });
    if (m.matchedBy && m.matchedBy === user.username) throw new ForbiddenException({ code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot override a 3-way match you performed', messageTh: 'ผู้จับคู่อนุมัติข้ามผลการตรวจของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    await db.update(invoiceMatchResults).set({ override: true, overrideBy: user.username, overrideReason: reason ?? null, overrideAt: new Date() }).where(eq(invoiceMatchResults.id, m.id));
    await this.statusLog.log('MATCH', m.matchNo, m.matchStatus, 'Override', user.username);
    return { txn_no: txnNo, match_status: m.matchStatus, payable: m.payable, override: true, override_by: user.username, matched_by: m.matchedBy };
  }

  // Automated re-match sweep (EXP-10; ridden by the BI scheduler `ap_automatch_rerun` job): re-run the
  // 3-way match for every BLOCKED invoice (not payable, not overridden) in the caller's tenant. A block
  // typically clears itself once the outstanding GR is posted (received qty/value catches up) — the sweep
  // turns that into an automatic release instead of a manual re-run. Override rows are never touched, and
  // each match() re-verdicts from CURRENT PO/GR state using the invoice lines recorded at first match.
  async rematchBlocked(user: JwtUser) {
    const db = this.db;
    const conds: any[] = [eq(invoiceMatchResults.payable, false), eq(invoiceMatchResults.override, false)];
    if (user.tenantId != null) conds.push(eq(invoiceMatchResults.tenantId, user.tenantId));
    const blocked = await db.select().from(invoiceMatchResults).where(and(...conds)).orderBy(desc(invoiceMatchResults.id)).limit(500);
    let released = 0; const results: any[] = [];
    for (const m of blocked) {
      if (!m.poNo) continue;
      const rows = await db.select().from(invoiceMatchLines).where(eq(invoiceMatchLines.matchId, Number(m.id)));
      const isHeader = rows.length === 1 && rows[0]!.itemId === '__TOTAL__';
      const lineInputs = isHeader ? undefined : rows.map((l: any) => ({ item_id: String(l.itemId), qty: n(l.invQty), unit_price: n(l.invPrice) }));
      const r = await this.match(m.txnNo, m.poNo, lineInputs, user);
      if (r.payable) released++;
      results.push({ txn_no: m.txnNo, po_no: m.poNo, match_status: r.match_status, payable: r.payable });
    }
    return { swept: results.length, released, results };
  }

  async getMatch(txnNo: string) {
    const db = this.db;
    const [m] = await db.select().from(invoiceMatchResults).where(eq(invoiceMatchResults.txnNo, txnNo)).limit(1);
    if (!m) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No match for this invoice', messageTh: 'ไม่พบการจับคู่' });
    const lines = await db.select().from(invoiceMatchLines).where(eq(invoiceMatchLines.matchId, Number(m.id)));
    return { match_no: m.matchNo, txn_no: m.txnNo, po_no: m.poNo, match_status: m.matchStatus, payable: m.payable, override: m.override, override_reason: m.overrideReason, lines: lines.map((l: any) => ({ item_id: l.itemId, inv_qty: n(l.invQty), inv_price: n(l.invPrice), po_price: n(l.poPrice), gr_qty: n(l.grQty), price_var_pct: n(l.priceVarPct), qty_var_pct: n(l.qtyVarPct), line_status: l.lineStatus })) };
  }

  // Match-results register / blocked-invoice worklist (ops/finance): every matched invoice for the caller's
  // tenant, filterable by status / blocked-only / search, with counts. "Blocked" = held from payment
  // (not payable AND not overridden) — the invoices the AP-pay gate (assertPayable) will refuse. Tenant-scoped
  // explicitly (an HQ/Admin request bypasses RLS); typed builders only at user-input sites.
  async listResults(q: { status?: string; blocked?: boolean; search?: string; limit?: number }, user: JwtUser) {
    const db = this.db;
    const conds: any[] = [];
    if (user.tenantId != null) conds.push(eq(invoiceMatchResults.tenantId, user.tenantId));
    if (q.status) conds.push(eq(invoiceMatchResults.matchStatus, q.status));
    if (q.blocked) conds.push(and(eq(invoiceMatchResults.payable, false), eq(invoiceMatchResults.override, false)));
    if (q.search) conds.push(or(like(invoiceMatchResults.txnNo, `%${q.search}%`), like(invoiceMatchResults.poNo, `%${q.search}%`))!);
    const where = conds.length ? and(...conds) : undefined;
    const rows = await db.select().from(invoiceMatchResults).where(where).orderBy(desc(invoiceMatchResults.id)).limit(q.limit ?? 100);
    const tenantWhere = user.tenantId != null ? eq(invoiceMatchResults.tenantId, user.tenantId) : undefined;
    const [agg] = await db.select({
      total: sql<string>`count(*)`,
      blocked: sql<string>`coalesce(sum(case when ${invoiceMatchResults.payable}=false and ${invoiceMatchResults.override}=true then 0 when ${invoiceMatchResults.payable}=false then 1 else 0 end),0)`,
      overridden: sql<string>`coalesce(sum(case when ${invoiceMatchResults.override}=true then 1 else 0 end),0)`,
    }).from(invoiceMatchResults).where(tenantWhere);
    return {
      results: rows.map((m: any) => ({ match_no: m.matchNo, txn_no: m.txnNo, po_no: m.poNo, match_status: m.matchStatus, payable: m.payable, override: m.override, override_by: m.overrideBy, matched_by: m.matchedBy, matched_at: m.matchedAt })),
      count: rows.length, total: n(agg?.total), blocked: n(agg?.blocked), overridden: n(agg?.overridden),
    };
  }
}
