import { Inject, Injectable, BadRequestException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { eq, and, asc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { bins, binStock, pickWaves, pickLists, pickListLines, shipments, dineInOrders, dineInOrderItems, custPosSales, custPosItems, stockMovements, lotLedger } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

// Warehouse execution: bins, putaway, wave → pick → pack → ship. Posts ZERO GL (COGS booked at sale-issue).
// Moves physical stock between bins via bin_stock + the existing stock_movements/lot_ledger audit.
@Injectable()
export class WmsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, private readonly docNo: DocNumberService) {}

  async createBin(dto: { bin_code: string; location_id?: string; bin_type?: string; aisle?: string; rack?: string; level?: string }, user: JwtUser) {
    const db = this.db as any;
    const [b] = await db.insert(bins).values({ tenantId: user.tenantId ?? null, binCode: dto.bin_code, locationId: dto.location_id ?? null, binType: dto.bin_type ?? 'storage', aisle: dto.aisle ?? null, rack: dto.rack ?? null, level: dto.level ?? null }).returning({ id: bins.id });
    return { id: Number(b.id), bin_code: dto.bin_code };
  }
  async listBins(_user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(bins).orderBy(asc(bins.binCode));
    return { bins: rows.map((b: any) => ({ id: Number(b.id), bin_code: b.binCode, location_id: b.locationId, bin_type: b.binType, active: b.active })) };
  }
  async binStockOf(binCode: string, user: JwtUser) {
    const db = this.db as any;
    const [b] = await db.select().from(bins).where(eq(bins.binCode, binCode)).limit(1);
    if (!b) throw new NotFoundException({ code: 'BIN_NOT_FOUND', message: 'Bin not found', messageTh: 'ไม่พบช่องเก็บ' });
    const rows = await db.select().from(binStock).where(eq(binStock.binId, Number(b.id)));
    return { bin_code: binCode, stock: rows.map((r: any) => ({ item_id: r.itemId, lot_no: r.lotNo, qty: n(r.qty) })) };
  }

  private async binByCode(db: any, tenantId: number, binCode: string) {
    const [b] = await db.select().from(bins).where(and(eq(bins.tenantId, tenantId), eq(bins.binCode, binCode))).limit(1);
    return b ?? null;
  }
  // a bin currently holding the item (FEFO-ish: earliest expiry / any positive qty)
  private async suggestPickBin(db: any, tenantId: number, itemId: string) {
    const [r] = await db.select().from(binStock).where(and(eq(binStock.tenantId, tenantId), eq(binStock.itemId, itemId), sql`${binStock.qty} > 0`)).orderBy(asc(binStock.expiryDate), asc(binStock.id)).limit(1);
    return r ?? null;
  }

  // ── PUTAWAY — record received stock into a bin. Idempotent per (gr_no, bin, item). ──
  async putaway(dto: { gr_no?: string; bin_code: string; item_id: string; lot_no?: string; qty: number; uom?: string; expiry_date?: string }, user: JwtUser) {
    const db = this.db as any;
    const tenantId = user.tenantId as number;
    const bin = await this.binByCode(db, tenantId, dto.bin_code);
    if (!bin) throw new NotFoundException({ code: 'BIN_NOT_FOUND', message: `Bin ${dto.bin_code} not found`, messageTh: 'ไม่พบช่องเก็บ' });
    const qty = n(dto.qty);
    const lot = dto.lot_no ?? '';
    // idempotency: a putaway movement for this (gr_no, bin, item) already logged → no-op
    if (dto.gr_no) {
      const [done] = await db.select({ id: stockMovements.id }).from(stockMovements).where(and(eq(stockMovements.docNo, dto.gr_no), eq(stockMovements.itemId, dto.item_id), eq(stockMovements.toLocation, `BIN:${dto.bin_code}`))).limit(1);
      if (done) { const [bs] = await db.select().from(binStock).where(and(eq(binStock.binId, Number(bin.id)), eq(binStock.itemId, dto.item_id), eq(binStock.lotNo, lot))).limit(1); return { bin_code: dto.bin_code, item_id: dto.item_id, qty: n(bs?.qty), duplicate: true }; }
    }
    const [bs] = await db.insert(binStock).values({ tenantId, binId: Number(bin.id), itemId: dto.item_id, lotNo: lot, qty: String(qty), uom: dto.uom ?? null, expiryDate: dto.expiry_date ?? null })
      .onConflictDoUpdate({ target: [binStock.tenantId, binStock.binId, binStock.itemId, binStock.lotNo], set: { qty: sql`${binStock.qty} + ${qty}`, lastUpdated: new Date() } }).returning({ qty: binStock.qty });
    await db.insert(stockMovements).values({ moveDate: new Date(), docNo: dto.gr_no ?? null, moveType: 'Transfer', itemId: dto.item_id, uom: dto.uom ?? null, qty: String(qty), fromLocation: 'Receiving', toLocation: `BIN:${dto.bin_code}`, refDoc: dto.gr_no ?? null, createdBy: user.username });
    if (dto.lot_no) await db.insert(lotLedger).values({ lotNo: dto.lot_no, itemId: dto.item_id, uom: dto.uom ?? null, locationId: dto.bin_code, grNo: dto.gr_no ?? null, qtyIn: String(qty), qtyOut: '0', balance: String(qty), expiryDate: dto.expiry_date ?? null, status: 'Active', moveDate: new Date(), refDoc: dto.gr_no ?? null, createdBy: user.username });
    return { bin_code: dto.bin_code, item_id: dto.item_id, qty: n(bs?.qty) };
  }

  // ── WAVE — batch N fulfillment orders into pick lists. Idempotent per (source_type, source_ref). ──
  async createWave(dto: { orders: { source_type: 'DINEIN' | 'POS' | 'SO'; source_ref: string }[] }, user: JwtUser) {
    const db = this.db as any;
    const tenantId = user.tenantId as number;
    if (!dto.orders?.length) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'No orders', messageTh: 'ไม่มีออเดอร์' });
    const waveNo = await this.docNo.nextDaily('WAVE');
    const [w] = await db.insert(pickWaves).values({ tenantId, waveNo, status: 'Open', orderCount: dto.orders.length, createdBy: user.username }).returning({ id: pickWaves.id });
    let pickCount = 0, lineCount = 0;
    for (const o of dto.orders) {
      const pickNo = await this.docNo.nextDaily('PICK');
      const ins = await db.insert(pickLists).values({ tenantId, pickNo, waveId: Number(w.id), sourceType: o.source_type, sourceRef: o.source_ref, status: 'Open', createdBy: user.username })
        .onConflictDoNothing({ target: [pickLists.tenantId, pickLists.sourceType, pickLists.sourceRef] }).returning({ id: pickLists.id });
      if (!ins.length) continue; // already waved → skip
      pickCount++;
      const lines = await this.resolveOrderLines(db, o.source_type, o.source_ref);
      for (const l of lines) {
        const bin = await this.suggestPickBin(db, tenantId, l.itemId);
        await db.insert(pickListLines).values({ tenantId, pickId: Number(ins[0].id), itemId: l.itemId, itemDescription: l.desc, requestedQty: String(l.qty), binId: bin ? Number(bin.id) : null, lotNo: bin?.lotNo || null, uom: l.uom ?? null, status: 'Open' });
        lineCount++;
      }
    }
    return { wave_no: waveNo, pick_count: pickCount, lines: lineCount };
  }
  private async resolveOrderLines(db: any, type: string, ref: string): Promise<{ itemId: string; desc: string; qty: number; uom?: string }[]> {
    if (type === 'DINEIN') {
      const [o] = await db.select().from(dineInOrders).where(eq(dineInOrders.orderNo, ref)).limit(1);
      if (!o) return [];
      const rows = await db.select().from(dineInOrderItems).where(eq(dineInOrderItems.orderId, Number(o.id)));
      return rows.map((r: any) => ({ itemId: String(r.itemId ?? r.name), desc: r.name, qty: n(r.qty) }));
    }
    // POS / SO → cust_pos_sales lines
    const [sale] = await db.select().from(custPosSales).where(eq(custPosSales.saleNo, ref)).limit(1);
    if (!sale) return [];
    const rows = await db.select().from(custPosItems).where(eq(custPosItems.saleId, Number(sale.id)));
    return rows.map((r: any) => ({ itemId: String(r.itemId), desc: r.itemDescription, qty: n(r.qty), uom: r.uom }));
  }

  // ── PICK — confirm physical pick; decrement bin_stock. NO GL. Idempotent (re-pick a Picked line no-ops). ──
  async pick(pickNo: string, dto: { lines: { pick_line_id: number; picked_qty: number; bin_code?: string }[] }, user: JwtUser) {
    const db = this.db as any;
    const tenantId = user.tenantId as number;
    const [p] = await db.select().from(pickLists).where(eq(pickLists.pickNo, pickNo)).for('update').limit(1);
    if (!p) throw new NotFoundException({ code: 'PICK_NOT_FOUND', message: 'Pick list not found', messageTh: 'ไม่พบใบหยิบ' });
    let picked = 0;
    for (const dl of dto.lines) {
      const [line] = await db.select().from(pickListLines).where(eq(pickListLines.id, dl.pick_line_id)).limit(1);
      if (!line || line.status === 'Picked') continue; // idempotent
      const want = n(dl.picked_qty);
      let bin: any = dl.bin_code ? await this.binByCode(db, tenantId, dl.bin_code) : (line.binId ? (await db.select().from(bins).where(eq(bins.id, Number(line.binId))).limit(1))[0] : await this.suggestPickBin(db, tenantId, line.itemId).then((bs: any) => bs ? { id: bs.binId } : null));
      const lot = line.lotNo ?? '';
      const [bs] = bin ? await db.select().from(binStock).where(and(eq(binStock.binId, Number(bin.id)), eq(binStock.itemId, line.itemId), eq(binStock.lotNo, lot || ''))).for('update').limit(1) : [null];
      if (!bs || n(bs.qty) < want) { await db.update(pickListLines).set({ status: 'Short', pickedQty: String(n(bs?.qty)) }).where(eq(pickListLines.id, line.id)); throw new UnprocessableEntityException({ code: 'PICK_SHORT', message: `Insufficient bin stock for ${line.itemId} (have ${n(bs?.qty)}, need ${want})`, messageTh: 'สต็อกในช่องไม่พอ' }); }
      await db.update(binStock).set({ qty: String(n(bs.qty) - want), lastUpdated: new Date() }).where(eq(binStock.id, bs.id));
      await db.insert(stockMovements).values({ moveDate: new Date(), docNo: pickNo, moveType: 'Issue', itemId: line.itemId, uom: line.uom ?? null, qty: String(-want), fromLocation: `BIN:${bin.binCode ?? ''}`, toLocation: 'Shipping', refDoc: p.sourceRef, createdBy: user.username });
      if (line.lotNo) await db.insert(lotLedger).values({ lotNo: line.lotNo, itemId: line.itemId, qtyIn: '0', qtyOut: String(want), balance: String(n(bs.qty) - want), status: 'Active', moveDate: new Date(), refDoc: pickNo, createdBy: user.username });
      await db.update(pickListLines).set({ pickedQty: String(want), status: 'Picked' }).where(eq(pickListLines.id, line.id));
      picked += want;
    }
    const remaining = await db.select({ id: pickListLines.id }).from(pickListLines).where(and(eq(pickListLines.pickId, Number(p.id)), eq(pickListLines.status, 'Open')));
    const status = remaining.length ? 'Picking' : 'Picked';
    await db.update(pickLists).set({ status }).where(eq(pickLists.id, p.id));
    return { pick_no: pickNo, status, picked };
  }

  // ── PACK — create the shipment shell. Requires pick Picked. Idempotent (returns existing). ──
  async pack(pickNo: string, user: JwtUser) {
    const db = this.db as any;
    const [p] = await db.select().from(pickLists).where(eq(pickLists.pickNo, pickNo)).limit(1);
    if (!p) throw new NotFoundException({ code: 'PICK_NOT_FOUND', message: 'Pick list not found', messageTh: 'ไม่พบใบหยิบ' });
    if (p.status !== 'Picked' && p.status !== 'Packed') throw new BadRequestException({ code: 'NOT_PICKED', message: 'Pick must be fully picked before packing', messageTh: 'ต้องหยิบครบก่อนแพ็ค' });
    const [ex] = await db.select().from(shipments).where(eq(shipments.pickId, Number(p.id))).limit(1);
    if (ex) return { shipment_no: ex.shipmentNo, status: ex.status };
    const shipmentNo = await this.docNo.nextDaily('SHP');
    await db.insert(shipments).values({ tenantId: user.tenantId ?? null, shipmentNo, pickId: Number(p.id), waveId: p.waveId, sourceType: p.sourceType, sourceRef: p.sourceRef, status: 'Packed', packedBy: user.username, packedAt: new Date() });
    await db.update(pickLists).set({ status: 'Packed' }).where(eq(pickLists.id, p.id));
    return { shipment_no: shipmentNo, status: 'Packed' };
  }

  // ── SHIP — carrier + tracking. NO GL. Idempotent (already Shipped returns current). ──
  async ship(shipmentNo: string, dto: { carrier: string; tracking_no: string }, user: JwtUser) {
    const db = this.db as any;
    const [sh] = await db.select().from(shipments).where(eq(shipments.shipmentNo, shipmentNo)).limit(1);
    if (!sh) throw new NotFoundException({ code: 'SHIPMENT_NOT_FOUND', message: 'Shipment not found', messageTh: 'ไม่พบการจัดส่ง' });
    if (sh.status === 'Shipped') return { shipment_no: shipmentNo, tracking_no: sh.trackingNo, status: 'Shipped' };
    await db.update(shipments).set({ carrier: dto.carrier, trackingNo: dto.tracking_no, status: 'Shipped', shippedBy: user.username, shippedAt: new Date() }).where(eq(shipments.id, sh.id));
    if (sh.pickId) await db.update(pickLists).set({ status: 'Shipped' }).where(eq(pickLists.id, Number(sh.pickId)));
    return { shipment_no: shipmentNo, tracking_no: dto.tracking_no, status: 'Shipped' };
  }

  // ── 17C: GR → putaway. Derived task list = received (GR) minus already-put-away (Transfer→BIN), per item.
  // No new table — the existing idempotent putaway() executes each task. ──
  async pendingPutaway(grNo: string, user: JwtUser) {
    const db = this.db as any;
    const recv = await db.select({ itemId: stockMovements.itemId, desc: stockMovements.itemDescription, uom: stockMovements.uom, qty: sql<string>`coalesce(sum(${stockMovements.qty}),0)` })
      .from(stockMovements).where(and(eq(stockMovements.docNo, grNo), eq(stockMovements.moveType, 'GR'))).groupBy(stockMovements.itemId, stockMovements.itemDescription, stockMovements.uom);
    const away = await db.select({ itemId: stockMovements.itemId, qty: sql<string>`coalesce(sum(${stockMovements.qty}),0)` })
      .from(stockMovements).where(and(eq(stockMovements.docNo, grNo), eq(stockMovements.moveType, 'Transfer'))).groupBy(stockMovements.itemId);
    const awayMap = new Map<string, number>(away.map((a: any) => [a.itemId, n(a.qty)]));
    const [firstBin] = await db.select().from(bins).limit(1);
    const tasks: any[] = [];
    for (const r of recv) {
      const pending = Math.round((n(r.qty) - (awayMap.get(r.itemId) ?? 0)) * 1000) / 1000;
      if (pending <= 0) continue;
      tasks.push({ gr_no: grNo, item_id: r.itemId, description: r.desc, pending_qty: pending, uom: r.uom, suggested_bin: firstBin?.binCode ?? null });
    }
    return { gr_no: grNo, tasks, count: tasks.length };
  }

  // ── 17C: wave-consolidated ship — ship all of a wave's packed shipments under ONE carrier/tracking. ──
  async shipWave(waveNo: string, dto: { carrier: string; tracking_no: string }, user: JwtUser) {
    const db = this.db as any;
    const [w] = await db.select().from(pickWaves).where(eq(pickWaves.waveNo, waveNo)).limit(1);
    if (!w) throw new NotFoundException({ code: 'WAVE_NOT_FOUND', message: `Wave ${waveNo} not found`, messageTh: 'ไม่พบเวฟ' });
    const shps = await db.select().from(shipments).where(eq(shipments.waveId, Number(w.id)));
    if (!shps.length) throw new BadRequestException({ code: 'NO_SHIPMENTS', message: 'No packed shipments in this wave', messageTh: 'ยังไม่มีพัสดุที่แพ็คในเวฟนี้' });
    let shipped = 0;
    for (const sh of shps) {
      if (sh.status === 'Shipped') continue;
      await db.update(shipments).set({ carrier: dto.carrier, trackingNo: dto.tracking_no, status: 'Shipped', shippedBy: user.username, shippedAt: new Date() }).where(eq(shipments.id, sh.id));
      if (sh.pickId) await db.update(pickLists).set({ status: 'Shipped' }).where(eq(pickLists.id, Number(sh.pickId)));
      shipped++;
    }
    await db.update(pickWaves).set({ status: 'Shipped' }).where(eq(pickWaves.id, Number(w.id)));
    return { wave_no: waveNo, consolidated_shipments: shps.length, shipped, tracking_no: dto.tracking_no };
  }
}
