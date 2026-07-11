import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { transferOrders, transferOrderLines } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { InventoryLedgerService, type LayerSlice } from '../inventory/inventory-ledger.service';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;
const bad = (code: string, message: string, messageTh: string) => new BadRequestException({ code, message, messageTh });

export interface TransferOrderLineDto { item_id: string; item_description?: string; uom?: string; qty: number }
export interface CreateTransferOrderDto { from_location: string; to_location: string; remarks?: string; lines: TransferOrderLineDto[] }

/**
 * Inter-warehouse/branch TRANSFER ORDER (INV-2, control INV-16) — a two-step ship→receive move that keeps
 * ownership in a Goods-in-Transit control account (1255) between the two events. It is DISTINCT from the
 * instant value-neutral stock-ops transfer (StockOpsService.transfer), which is left unchanged.
 *
 *   • create → Draft (document only; no stock/GL move).
 *   • ship   → relieves the source location's valued stock into in-transit: Dr 1255 / Cr 1200 (per item, at
 *              current cost via InventoryLedgerService); status Shipped; the ship-time cost snapshot is pinned
 *              on each line (FIFO/FEFO layer slices carried forward for the receive leg).
 *   • receive→ lands the stock at the destination: Dr 1200 / Cr 1255; status Received. Custody segregation
 *              (SoD): the receiver must DIFFER from the shipper (SOD_SELF_APPROVAL).
 *   • in-transit aging → the period-end cutoff report: every still-Shipped TO with its days-in-transit +
 *              value, so unreceived in-transit inventory is visible and can be cut off at period end.
 */
@Injectable()
export class TransferOrderService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly invLedger: InventoryLedgerService,
  ) {}

  private tid(user: JwtUser): number {
    if (user.tenantId == null) throw bad('NO_TENANT', 'User is not bound to a tenant', 'ผู้ใช้ไม่ได้ผูกกับร้าน/บริษัท');
    return Number(user.tenantId);
  }

  private async header(tenantId: number, toNo: string) {
    const [h] = await this.db.select().from(transferOrders).where(and(eq(transferOrders.tenantId, tenantId), eq(transferOrders.toNo, toNo))).limit(1);
    return h ?? null;
  }

  async create(dto: CreateTransferOrderDto, user: JwtUser) {
    if (!dto.lines?.length) throw bad('NO_LINES', 'No items', 'ไม่มีรายการ');
    if (dto.from_location === dto.to_location) throw bad('SAME_LOCATION', 'From and To must differ', 'ต้นทาง/ปลายทางต้องต่างกัน');
    const tenantId = this.tid(user);
    const toNo = await this.docNo.nextDaily('TO');
    await this.db.insert(transferOrders).values({
      tenantId, toNo, fromLocation: dto.from_location, toLocation: dto.to_location, status: 'Draft',
      remarks: dto.remarks ?? null, createdBy: user.username,
    });
    await this.db.insert(transferOrderLines).values(dto.lines.map((l) => ({
      tenantId, toNo, itemId: l.item_id, itemDescription: l.item_description ?? null, uom: l.uom ?? null, qty: String(round4(l.qty)),
    })));
    return { to_no: toNo, status: 'Draft' as const, from_location: dto.from_location, to_location: dto.to_location, lines: dto.lines.length };
  }

  // Ship: relieve source stock into in-transit + book Dr 1255 / Cr 1200 per line, pinning the cost snapshot.
  async ship(toNo: string, user: JwtUser) {
    const tenantId = this.tid(user);
    const h = await this.header(tenantId, toNo);
    if (!h) throw new NotFoundException({ code: 'NOT_FOUND', message: `Transfer order ${toNo} not found`, messageTh: 'ไม่พบใบโอนสินค้า' });
    if (h.status !== 'Draft') throw bad('NOT_DRAFT', `Transfer order ${toNo} is ${h.status}; only a Draft can be shipped`, 'โอนได้เฉพาะใบสถานะร่างเท่านั้น');
    const lines = await this.db.select().from(transferOrderLines).where(and(eq(transferOrderLines.tenantId, tenantId), eq(transferOrderLines.toNo, toNo)));
    let totalValue = 0; let valuedLines = 0; const jeNos: string[] = [];
    for (const l of lines) {
      const r = await this.invLedger.shipToInTransit({ item_id: l.itemId, item_description: l.itemDescription, from_location: h.fromLocation, qty: n(l.qty), ref_type: 'TO', ref_id: `${toNo}#${l.id}` }, user);
      const value = round4(r.value ?? 0);
      totalValue = round4(totalValue + value);
      if (r.valued) { valuedLines++; if (r.gl_entry_no) jeNos.push(r.gl_entry_no); }
      await this.db.update(transferOrderLines).set({
        unitCost: String(round4(r.unit_cost ?? 0)), lineValue: String(value),
        costSlices: r.valued ? JSON.stringify(r.slices ?? []) : null,
      }).where(eq(transferOrderLines.id, l.id));
    }
    await this.db.update(transferOrders).set({
      status: 'Shipped', shippedBy: user.username, shippedAt: new Date(), shipGlEntryNo: jeNos.join(',') || null,
    }).where(and(eq(transferOrders.tenantId, tenantId), eq(transferOrders.toNo, toNo)));
    return { to_no: toNo, status: 'Shipped' as const, from_location: h.fromLocation, to_location: h.toLocation, lines: lines.length, valued_lines: valuedLines, in_transit_value: totalValue, gl_entry_nos: jeNos };
  }

  // Receive: land the shipped snapshot at the destination + book Dr 1200 / Cr 1255. Custody SoD: receiver ≠ shipper.
  async receive(toNo: string, user: JwtUser) {
    const tenantId = this.tid(user);
    const h = await this.header(tenantId, toNo);
    if (!h) throw new NotFoundException({ code: 'NOT_FOUND', message: `Transfer order ${toNo} not found`, messageTh: 'ไม่พบใบโอนสินค้า' });
    if (h.status !== 'Shipped') throw bad('NOT_SHIPPED', `Transfer order ${toNo} is ${h.status}; only a Shipped order can be received`, 'รับได้เฉพาะใบที่ส่งของแล้วเท่านั้น');
    // INV-16 custody segregation (SoD): the person who SHIPPED may not also receive the same transfer — an
    // independent custodian confirms arrival, so in-transit stock cannot be shipped and self-confirmed by one hand.
    if (h.shippedBy && h.shippedBy === user.username) {
      throw new ForbiddenException({ code: 'SOD_SELF_APPROVAL', message: 'The shipper cannot receive their own transfer — an independent custodian must confirm arrival', messageTh: 'ผู้ส่งสินค้าไม่สามารถรับสินค้าของตนเองได้ (ต้องมีผู้รับอิสระยืนยัน)' });
    }
    const lines = await this.db.select().from(transferOrderLines).where(and(eq(transferOrderLines.tenantId, tenantId), eq(transferOrderLines.toNo, toNo)));
    let totalValue = 0; let valuedLines = 0; const jeNos: string[] = [];
    for (const l of lines) {
      let slices: LayerSlice[] = [];
      if (l.costSlices) { try { slices = JSON.parse(l.costSlices) as LayerSlice[]; } catch { slices = []; } }
      const r = await this.invLedger.receiveFromInTransit({ item_id: l.itemId, item_description: l.itemDescription, to_location: h.toLocation, qty: n(l.qty), value: n(l.lineValue), unit_cost: n(l.unitCost), slices, ref_type: 'TO', ref_id: `${toNo}#${l.id}` }, user);
      if (r.valued) { valuedLines++; totalValue = round4(totalValue + n(l.lineValue)); if (r.gl_entry_no) jeNos.push(r.gl_entry_no); }
    }
    await this.db.update(transferOrders).set({
      status: 'Received', receivedBy: user.username, receivedAt: new Date(), receiveGlEntryNo: jeNos.join(',') || null,
    }).where(and(eq(transferOrders.tenantId, tenantId), eq(transferOrders.toNo, toNo)));
    return { to_no: toNo, status: 'Received' as const, from_location: h.fromLocation, to_location: h.toLocation, lines: lines.length, valued_lines: valuedLines, received_value: totalValue, gl_entry_nos: jeNos };
  }

  async list(user: JwtUser, status?: string, limit = 100) {
    const tenantId = this.tid(user);
    const conds = [eq(transferOrders.tenantId, tenantId)];
    if (status) conds.push(eq(transferOrders.status, status));
    const rows = await this.db.select().from(transferOrders).where(and(...conds)).orderBy(desc(transferOrders.id)).limit(limit);
    return { transfer_orders: rows.map((r) => this.summ(r)), count: rows.length };
  }

  async get(toNo: string, user: JwtUser) {
    const tenantId = this.tid(user);
    const h = await this.header(tenantId, toNo);
    if (!h) throw new NotFoundException({ code: 'NOT_FOUND', message: `Transfer order ${toNo} not found`, messageTh: 'ไม่พบใบโอนสินค้า' });
    const lines = await this.db.select().from(transferOrderLines).where(and(eq(transferOrderLines.tenantId, tenantId), eq(transferOrderLines.toNo, toNo)));
    return {
      ...this.summ(h),
      lines: lines.map((l) => ({ item_id: l.itemId, item_description: l.itemDescription, uom: l.uom, qty: n(l.qty), unit_cost: n(l.unitCost), line_value: n(l.lineValue) })),
    };
  }

  // INV-16 — in-transit aging / period-end cutoff report: every still-Shipped transfer order with its
  // days-in-transit and value, bucketed. Long-outstanding in-transit lines are the cutoff exceptions an
  // auditor tests for inventory existence at period end.
  async inTransitAging(user: JwtUser, asOf?: string) {
    const tenantId = this.tid(user);
    const rows = await this.db.select().from(transferOrders).where(and(eq(transferOrders.tenantId, tenantId), eq(transferOrders.status, 'Shipped'))).orderBy(desc(transferOrders.shippedAt));
    const now = asOf ? new Date(asOf + 'T00:00:00Z') : new Date();
    const buckets: Record<string, { count: number; value: number }> = { '0-7': { count: 0, value: 0 }, '8-30': { count: 0, value: 0 }, '31+': { count: 0, value: 0 } };
    const items: any[] = [];
    let totalValue = 0;
    for (const r of rows) {
      const linesVal = await this.db.select().from(transferOrderLines).where(and(eq(transferOrderLines.tenantId, tenantId), eq(transferOrderLines.toNo, r.toNo)));
      const value = round4(linesVal.reduce((a, l) => a + n(l.lineValue), 0));
      const days = r.shippedAt ? Math.max(0, Math.floor((now.getTime() - new Date(r.shippedAt).getTime()) / 86400000)) : 0;
      const bucket = days <= 7 ? '0-7' : days <= 30 ? '8-30' : '31+';
      buckets[bucket]!.count++; buckets[bucket]!.value = round4(buckets[bucket]!.value + value);
      totalValue = round4(totalValue + value);
      items.push({ to_no: r.toNo, from_location: r.fromLocation, to_location: r.toLocation, shipped_by: r.shippedBy, shipped_at: r.shippedAt, days_in_transit: days, aging_bucket: bucket, value, lines: linesVal.length });
    }
    return { as_of: asOf ?? now.toISOString().slice(0, 10), open_count: items.length, total_in_transit_value: totalValue, buckets, items };
  }

  private summ(r: typeof transferOrders.$inferSelect) {
    return {
      to_no: r.toNo, status: r.status, from_location: r.fromLocation, to_location: r.toLocation, remarks: r.remarks,
      shipped_by: r.shippedBy, shipped_at: r.shippedAt, received_by: r.receivedBy, received_at: r.receivedAt,
      ship_gl_entry_no: r.shipGlEntryNo, receive_gl_entry_no: r.receiveGlEntryNo, created_by: r.createdBy, created_at: r.createdAt,
    };
  }
}
