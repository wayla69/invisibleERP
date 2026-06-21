import { Inject, Injectable } from '@nestjs/common';
import { eq, and, sql, inArray, asc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { customerInventory, purchaseOrders, poItems, stockAllocations } from '../../database/schema';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

// Available-To-Promise: on_hand − allocated − safety + scheduled_receipts(open POs within the horizon).
@Injectable()
export class AtpService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async atp(tenantId: number, itemId: string, needBy: string) {
    const db = this.db as any;
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

  async allocate(tenantId: number, itemId: string, qty: number, refDoc: string, needBy: string | undefined, _user: JwtUser) {
    const db = this.db as any;
    await db.insert(stockAllocations).values({ tenantId, itemId, refDoc, qty: String(qty), needBy: needBy ?? null, status: 'Open' });
    return { item_id: itemId, ref_doc: refDoc, qty, status: 'Open' };
  }
}
