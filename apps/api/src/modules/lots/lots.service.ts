import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc, asc, sql, gt } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { lotLedger, lotHolds, goodsReceipts, purchaseOrders, pickLists, custPosSales } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { n, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);

// INV-5 / INV-18 — lot/batch traceability + quarantine (hold) control over lot_ledger.
// Read views (ledger inquiry, expiry buckets, FEFO) PLUS: backward/forward genealogy trace and a lot HOLD
// that excludes a recalled/suspect lot from FEFO pick-suggestion and WMS wave allocation.
@Injectable()
export class LotsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
  ) {}

  // The set of lot_nos currently on HOLD for the caller's tenant (RLS scopes lot_holds automatically).
  // A lot is Held when its LATEST hold row is 'Held'. Optionally narrow to one item.
  private async heldLotNos(itemId?: string): Promise<Set<string>> {
    const conds: any[] = [];
    if (itemId) conds.push(eq(lotHolds.itemId, itemId));
    const rows = await this.db.select({ lotNo: lotHolds.lotNo, status: lotHolds.status, id: lotHolds.id })
      .from(lotHolds).where(conds.length ? and(...conds) : undefined).orderBy(desc(lotHolds.id));
    const latest = new Map<string, string>();
    for (const r of rows) if (!latest.has(r.lotNo)) latest.set(r.lotNo, r.status);
    return new Set([...latest.entries()].filter(([, st]) => st === 'Held').map(([lot]) => lot));
  }

  async ledger(q: { item_id?: string; location?: string; status?: string; limit?: number }) {
    const db = this.db;
    const conds: any[] = [];
    if (q.item_id) conds.push(eq(lotLedger.itemId, q.item_id));
    if (q.location) conds.push(eq(lotLedger.locationId, q.location));
    if (q.status) conds.push(eq(lotLedger.status, q.status as NonNullable<typeof lotLedger.$inferSelect.status>));
    const rows = await db.select().from(lotLedger).where(conds.length ? and(...conds) : undefined).orderBy(desc(lotLedger.id)).limit(q.limit ?? 200);
    const held = await this.heldLotNos(q.item_id);
    return { lots: rows.map((r) => ({ ...shape(r), hold_status: held.has(String(r.lotNo)) ? 'Held' : 'None' })), count: rows.length };
  }

  async expiry() {
    const db = this.db;
    const today = ymd();
    const rows = await db.select().from(lotLedger).where(and(sql`${lotLedger.expiryDate} is not null`, gt(lotLedger.balance, sql`0`))).orderBy(asc(lotLedger.expiryDate));
    type ExpiryRow = ReturnType<typeof shape> & { days_to_expiry: number };
    const buckets = { expired: [] as ExpiryRow[], d0_7: [] as ExpiryRow[], d8_30: [] as ExpiryRow[], d31_plus: [] as ExpiryRow[] };
    for (const r of rows) {
      const days = daysBetween(today, String(r.expiryDate));
      const o = { ...shape(r), days_to_expiry: days };
      if (days < 0) buckets.expired.push(o);
      else if (days <= 7) buckets.d0_7.push(o);
      else if (days <= 30) buckets.d8_30.push(o);
      else buckets.d31_plus.push(o);
    }
    return {
      summary: { expired: buckets.expired.length, d0_7: buckets.d0_7.length, d8_30: buckets.d8_30.length, d31_plus: buckets.d31_plus.length },
      buckets,
    };
  }

  // First-Expired-First-Out pick suggestion: active lots with balance, soonest expiry first. Aggregated per
  // lot_no (the ledger holds many rows per lot — receipts + issues — so one lot must surface once, at its
  // latest running balance). HELD lots are EXCLUDED — a quarantined lot must never be suggested (INV-18).
  async fefo(itemId: string) {
    const db = this.db;
    const rows = await db.select().from(lotLedger)
      .where(and(eq(lotLedger.itemId, itemId), eq(lotLedger.status, 'Active'), gt(lotLedger.balance, sql`0`)))
      .orderBy(asc(lotLedger.expiryDate));
    const held = await this.heldLotNos(itemId);
    // Collapse to one entry per lot_no (rows arrive earliest-expiry first). Net on-hand = Σ qty_in − Σ qty_out.
    const byLot = new Map<string, ReturnType<typeof shape> & { _in: number; _out: number }>();
    const heldSeen = new Set<string>();
    for (const r of rows) {
      const lot = String(r.lotNo);
      if (held.has(lot)) { heldSeen.add(lot); continue; }
      const cur = byLot.get(lot);
      if (!cur) byLot.set(lot, { ...shape(r), _in: n(r.qtyIn), _out: n(r.qtyOut) });
      else { cur._in += n(r.qtyIn); cur._out += n(r.qtyOut); }
    }
    const available = [...byLot.values()]
      .map(({ _in, _out, ...rest }) => ({ ...rest, balance: _in - _out }))
      .filter((r) => r.balance > 0);
    return {
      item_id: itemId,
      lots: available,
      count: available.length,
      total_balance: available.reduce((a, r) => a + r.balance, 0),
      excluded_held: heldSeen.size,
    };
  }

  // ── HOLD — quarantine a lot (recall / suspect quality). Idempotent: holding an already-Held lot no-ops. ──
  async hold(lotNo: string, dto: { reason?: string; item_id?: string }, user: JwtUser) {
    const db = this.db;
    const tenantId = user.tenantId as number;
    const latest = await this.latestHold(lotNo);
    if (latest && latest.status === 'Held') return { hold_no: latest.holdNo, lot_no: lotNo, status: 'Held', duplicate: true };
    // Derive the item from the ledger if not supplied (helps the trace/UI). Not required to place a hold.
    let itemId = dto.item_id ?? null;
    if (!itemId) { const [ll] = await db.select({ itemId: lotLedger.itemId }).from(lotLedger).where(eq(lotLedger.lotNo, lotNo)).limit(1); itemId = ll?.itemId ?? null; }
    const holdNo = await this.docNo.nextDaily('HOLD');
    await db.insert(lotHolds).values({ tenantId, holdNo, lotNo, itemId, status: 'Held', reason: dto.reason ?? null, heldBy: user.username, heldAt: new Date() });
    return { hold_no: holdNo, lot_no: lotNo, item_id: itemId, status: 'Held' };
  }

  // ── RELEASE — lift the quarantine and re-enable picking. Records a new Released row (audit trail kept). ──
  async release(lotNo: string, dto: { reason?: string }, user: JwtUser) {
    const db = this.db;
    const tenantId = user.tenantId as number;
    const latest = await this.latestHold(lotNo);
    if (!latest || latest.status !== 'Held') throw new BadRequestException({ code: 'LOT_NOT_HELD', message: `Lot ${lotNo} is not on hold`, messageTh: 'ล็อตนี้ไม่ได้ถูกระงับ' });
    await db.update(lotHolds).set({ status: 'Released', releasedBy: user.username, releasedAt: new Date(), releaseReason: dto.reason ?? null }).where(eq(lotHolds.id, latest.id));
    return { hold_no: latest.holdNo, lot_no: lotNo, item_id: latest.itemId, status: 'Released' };
  }

  private async latestHold(lotNo: string) {
    const [r] = await this.db.select().from(lotHolds).where(eq(lotHolds.lotNo, lotNo)).orderBy(desc(lotHolds.id)).limit(1);
    return r ?? null;
  }

  // ── TRACE — full genealogy for a lot (recall investigation, INV-18) ──
  // Backward: lot → goods receipt(s) → supplier(s). Forward: lot → issues/picks → sales → customer(s).
  async trace(lotNo: string) {
    const db = this.db;
    const ledgerRows = await db.select().from(lotLedger).where(eq(lotLedger.lotNo, lotNo)).orderBy(asc(lotLedger.id));
    if (!ledgerRows.length) throw new NotFoundException({ code: 'LOT_NOT_FOUND', message: `Lot ${lotNo} not found`, messageTh: 'ไม่พบล็อต' });
    const first = ledgerRows[0]!;
    const balance = ledgerRows.reduce((a, r) => a + n(r.qtyIn) - n(r.qtyOut), 0);
    const latest = await this.latestHold(lotNo);
    const holdStatus = latest && latest.status === 'Held' ? 'Held' : 'None';

    // ── Backward: receipts (lot_ledger.gr_no, qty_in rows) → goods_receipts → PO → vendor ──
    const grNos = [...new Set(ledgerRows.filter((r) => r.grNo).map((r) => String(r.grNo)))];
    const receipts: any[] = [];
    const supplierMap = new Map<string, { vendor_id: number | null; vendor_name: string | null }>();
    for (const grNo of grNos) {
      const [gr] = await db.select().from(goodsReceipts).where(eq(goodsReceipts.grNo, grNo)).limit(1);
      if (!gr) { receipts.push({ gr_no: grNo, gr_date: null, po_no: null, vendor_id: null, vendor_name: null }); continue; }
      let poNo = gr.poNo ?? null, vendorName = gr.vendorName ?? null, vendorId = gr.vendorId ?? null;
      if (poNo && (!vendorName || !vendorId)) {
        const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.poNo, poNo)).limit(1);
        if (po) { vendorName = vendorName ?? po.vendorName; vendorId = vendorId ?? po.vendorId; }
      }
      receipts.push({ gr_no: grNo, gr_date: gr.grDate, po_no: poNo, vendor_id: vendorId, vendor_name: vendorName });
      const key = String(vendorId ?? vendorName ?? grNo);
      if (!supplierMap.has(key)) supplierMap.set(key, { vendor_id: vendorId, vendor_name: vendorName });
    }

    // ── Forward: issue rows (qty_out > 0) → ref_doc (pick_no / issue doc) → pick_list → sale → customer ──
    const issues = ledgerRows.filter((r) => n(r.qtyOut) > 0).map((r) => ({ ref_doc: r.refDoc, qty_out: n(r.qtyOut), move_date: r.moveDate }));
    const refDocs = [...new Set(issues.filter((i) => i.ref_doc).map((i) => String(i.ref_doc)))];
    const shipments: any[] = [];
    const customerMap = new Map<string, { source_type: string; source_ref: string; sale_no: string | null; sale_date: any; branch_id: number | null }>();
    for (const ref of refDocs) {
      const [pk] = await db.select().from(pickLists).where(eq(pickLists.pickNo, ref)).limit(1);
      if (!pk) { shipments.push({ ref_doc: ref, source_type: null, source_ref: null, sale_no: null }); continue; }
      let saleNo: string | null = null, saleDate: any = null, branchId: number | null = null;
      if (pk.sourceType === 'POS' || pk.sourceType === 'SO') {
        const [sale] = await db.select().from(custPosSales).where(eq(custPosSales.saleNo, pk.sourceRef)).limit(1);
        if (sale) { saleNo = sale.saleNo; saleDate = sale.saleDate; branchId = sale.branchId; }
      }
      shipments.push({ ref_doc: ref, source_type: pk.sourceType, source_ref: pk.sourceRef, sale_no: saleNo ?? pk.sourceRef, status: pk.status });
      const key = String(pk.sourceRef);
      if (!customerMap.has(key)) customerMap.set(key, { source_type: pk.sourceType, source_ref: pk.sourceRef, sale_no: saleNo, sale_date: saleDate, branch_id: branchId });
    }

    return {
      lot_no: lotNo,
      lot: { item_id: first.itemId, item_description: first.itemDescription, uom: first.uom, balance, expiry_date: first.expiryDate, status: first.status },
      hold: { status: holdStatus, ...(latest ? { hold_no: latest.holdNo, reason: latest.reason, held_by: latest.heldBy, held_at: latest.heldAt, released_by: latest.releasedBy, released_at: latest.releasedAt } : {}) },
      backward: { receipts, suppliers: [...supplierMap.values()] },
      forward: { issues, shipments, customers: [...customerMap.values()] },
    };
  }
}

function shape(r: any) {
  return { lot_no: r.lotNo, item_id: r.itemId, item_description: r.itemDescription, uom: r.uom, location_id: r.locationId, gr_no: r.grNo, qty_in: n(r.qtyIn), qty_out: n(r.qtyOut), balance: n(r.balance), expiry_date: r.expiryDate, status: r.status, ref_doc: r.refDoc };
}
