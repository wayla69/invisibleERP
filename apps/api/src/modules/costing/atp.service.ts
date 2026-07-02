import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { eq, and, sql, inArray, asc, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { customerInventory, purchaseOrders, poItems, stockAllocations } from '../../database/schema';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const r4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;

// Available-To-Promise: on_hand − allocated − safety + scheduled_receipts(open POs within the horizon).
// Reservations (stock_allocations) carry a lifecycle Open → Fulfilled (shipped/issued) | Cancelled (released).
// ATP nets only OPEN reservations, so a fulfilled/cancelled reservation is released and ATP cannot drift
// (INV-09). allocate() is idempotent per (tenant, ref_doc, item) and refuses to reserve beyond ATP.
@Injectable()
export class AtpService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async atp(tenantId: number, itemId: string, needBy: string) {
    const db = this.db;
    const [inv] = await db.select().from(customerInventory).where(and(eq(customerInventory.tenantId, tenantId), eq(customerInventory.itemId, itemId))).limit(1);
    const onHand = n(inv?.currentStock);
    const safety = n(inv?.reorderPoint);
    const [alloc] = await db.select({ v: sql<string>`coalesce(sum(${stockAllocations.qty}),0)` }).from(stockAllocations).where(and(eq(stockAllocations.tenantId, tenantId), eq(stockAllocations.itemId, itemId), eq(stockAllocations.status, 'Open')));
    const allocated = n(alloc?.v);
    // open PO scheduled receipts (purchase_orders is global; filter by item + expected within horizon)
    const rows = await db.select({ poNo: purchaseOrders.poNo, expected: purchaseOrders.expectedDate, orderQty: poItems.orderQty, recvQty: poItems.receivedQty })
      .from(poItems).innerJoin(purchaseOrders, eq(poItems.poId, purchaseOrders.id))
      .where(and(eq(poItems.itemId, itemId), inArray(purchaseOrders.status, ['Approved', 'Received'] as any)))
      .orderBy(asc(purchaseOrders.expectedDate));
    const scheduled: any[] = [];
    let scheduledQty = 0;
    for (const r of rows) {
      const open = n(r.orderQty) - n(r.recvQty);
      if (open <= 0) continue;
      if (r.expected && String(r.expected) > needBy) continue; // outside the promise horizon
      scheduled.push({ po_no: r.poNo, qty: open, expected_date: r.expected });
      scheduledQty += open;
    }
    const atpQty = Math.round((onHand - allocated - safety + scheduledQty) * 10000) / 10000;
    return { item_id: itemId, on_hand: onHand, allocated, safety, scheduled_receipts: scheduled, atp_qty: atpQty };
  }

  async canPromise(tenantId: number, itemId: string, qty: number, date: string) {
    const a = await this.atp(tenantId, itemId, date);
    const can = a.atp_qty >= qty - 1e-9;
    return { can_promise: can, atp_qty: a.atp_qty, requested: qty, shortfall: can ? 0 : Math.round((qty - a.atp_qty) * 10000) / 10000, first_available_date: can ? date : (a.scheduled_receipts[0]?.expected_date ?? null) };
  }

  // Reserve stock against a document. Idempotent per (tenant, ref_doc, item): re-allocating the same ref
  // ADJUSTS the existing Open reservation rather than stacking duplicates (a retried order can't leak the
  // float). The net additional reservation may not exceed current ATP (INV-09) — else INSUFFICIENT_ATP, so
  // a reservation can never oversell available-to-promise.
  async allocate(tenantId: number, itemId: string, qty: number, refDoc: string, needBy: string | undefined, _user: JwtUser) {
    const newQty = r4(qty);
    return await (this.db as any).transaction(async (tx: any) => {
      const [existing] = await tx.select().from(stockAllocations)
        .where(and(eq(stockAllocations.tenantId, tenantId), eq(stockAllocations.refDoc, refDoc), eq(stockAllocations.itemId, itemId), eq(stockAllocations.status, 'Open')))
        .for('update').limit(1);
      const existingQty = existing ? n(existing.qty) : 0;
      const delta = r4(newQty - existingQty);            // the additional stock this change reserves
      if (delta > 0) {
        const a = await this.atp(tenantId, itemId, needBy ?? '9999-12-31'); // atp already excludes the existing Open qty
        if (delta > a.atp_qty + 1e-9) throw new UnprocessableEntityException({ code: 'INSUFFICIENT_ATP', message: `Cannot reserve ${delta} of ${itemId} — only ${a.atp_qty} available-to-promise`, messageTh: `จองสินค้าเกินจำนวนที่พร้อมส่งมอบ (ATP ${a.atp_qty})` });
      }
      if (existing) await tx.update(stockAllocations).set({ qty: String(newQty), needBy: needBy ?? existing.needBy ?? null }).where(eq(stockAllocations.id, existing.id));
      else await tx.insert(stockAllocations).values({ tenantId, itemId, refDoc, qty: String(newQty), needBy: needBy ?? null, status: 'Open' });
      return { item_id: itemId, ref_doc: refDoc, qty: newQty, status: 'Open', adjusted: !!existing };
    });
  }

  // Release a reservation (order cancelled): Open → Cancelled. Frees the qty back to ATP.
  async releaseAllocation(tenantId: number, refDoc: string, _user: JwtUser) {
    const db = this.db;
    const rows = await db.update(stockAllocations).set({ status: 'Cancelled' })
      .where(and(eq(stockAllocations.tenantId, tenantId), eq(stockAllocations.refDoc, refDoc), eq(stockAllocations.status, 'Open')))
      .returning({ qty: stockAllocations.qty });
    return { ref_doc: refDoc, status: 'Cancelled', released_lines: rows.length, released_qty: r4(rows.reduce((s: number, a: any) => s + n(a.qty), 0)) };
  }

  // Fulfill a reservation when the goods physically ship/issue: Open → Fulfilled. The on-hand reduction is
  // posted by the issue path; marking it Fulfilled removes it from the OPEN reservation pool so ATP is not
  // double-counted (reservation + lower on-hand).
  async fulfillAllocation(tenantId: number, refDoc: string, _user: JwtUser) {
    const db = this.db;
    const rows = await db.update(stockAllocations).set({ status: 'Fulfilled' })
      .where(and(eq(stockAllocations.tenantId, tenantId), eq(stockAllocations.refDoc, refDoc), eq(stockAllocations.status, 'Open')))
      .returning({ qty: stockAllocations.qty });
    return { ref_doc: refDoc, status: 'Fulfilled', fulfilled_lines: rows.length, fulfilled_qty: r4(rows.reduce((s: number, a: any) => s + n(a.qty), 0)) };
  }

  // Reservation register — open (and optionally historical) allocations, for visibility / control review.
  async listAllocations(tenantId: number, opts: { item_id?: string; status?: string; ref_doc?: string }) {
    const db = this.db;
    const conds = [eq(stockAllocations.tenantId, tenantId)];
    if (opts.item_id) conds.push(eq(stockAllocations.itemId, opts.item_id));
    if (opts.status) conds.push(eq(stockAllocations.status, opts.status));
    if (opts.ref_doc) conds.push(eq(stockAllocations.refDoc, opts.ref_doc));
    const rows = await db.select().from(stockAllocations).where(and(...conds)).orderBy(desc(stockAllocations.id));
    const allocations = rows.map((a: any) => ({ id: Number(a.id), item_id: a.itemId, ref_doc: a.refDoc, qty: n(a.qty), need_by: a.needBy, status: a.status, created_at: a.createdAt }));
    return { allocations, count: allocations.length, open_qty: r4(allocations.filter((a: any) => a.status === 'Open').reduce((s: number, a: any) => s + a.qty, 0)) };
  }
}
