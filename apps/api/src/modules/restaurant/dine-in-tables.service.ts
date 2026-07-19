import { BadRequestException } from '@nestjs/common';
import { eq, and, inArray, ne } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { dineInOrders, dineInOrderItems, diningTables, tableSessions } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

// Floor operations sub-service (table transfer/merge, course/seat fire, seat assignment) — a PLAIN class
// built in the DineInService ctor body (not a DI provider; the god-service ratchet pattern). Owns the
// table-to-table item movements and the KDS fire/seat mechanics; order loading, totals refresh, status
// recompute and the order view stay on the facade and come in as ports.
export class DineInTablesService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly ports: {
      loadOrder: (orderNo: string) => Promise<any>;
      ensureOpenOrder: (tableId: number, user: JwtUser) => Promise<any>;
      liveSessionForTable: (tableId: number) => Promise<any>;
      refreshTotals: (orderId: number) => Promise<any>;
      recomputeOrderStatus: (orderId: number) => Promise<unknown>;
      getOrder: (orderNo: string, user: JwtUser) => Promise<any>;
    },
  ) {}

  async transferItems(orderNo: string, itemIds: number[], toTableId: number, user: JwtUser) {
    const db = this.db;
    const src = await this.ports.loadOrder(orderNo);
    if (['paid', 'closed', 'cancelled'].includes(String(src.status))) throw new BadRequestException({ code: 'ORDER_CLOSED', message: 'Order is closed', messageTh: 'ออเดอร์ปิดแล้ว' });
    const tgt = await this.ports.ensureOpenOrder(toTableId, user);
    if (Number(tgt.id) === Number(src.id)) throw new BadRequestException({ code: 'SAME_TABLE', message: 'Items are already on that table', messageTh: 'รายการอยู่ที่โต๊ะนั้นอยู่แล้ว' });
    const moved = await db.update(dineInOrderItems).set({ orderId: Number(tgt.id), updatedAt: new Date() })
      .where(and(eq(dineInOrderItems.orderId, Number(src.id)), inArray(dineInOrderItems.id, itemIds.map(Number)), ne(dineInOrderItems.kdsStatus, 'voided'))).returning({ id: dineInOrderItems.id });
    if (!moved.length) throw new BadRequestException({ code: 'NO_ITEMS', message: 'No matching items to transfer', messageTh: 'ไม่พบรายการที่จะย้าย' });
    for (const id of [Number(src.id), Number(tgt.id)]) { await this.ports.refreshTotals(id); await this.ports.recomputeOrderStatus(id); }
    return { moved: moved.length, from_order_no: src.orderNo, to_order_no: tgt.orderNo, to_table_id: toTableId };
  }

  // merge another table's tab into this one: move its items into the target order, close the source session/table
  async mergeTables(targetTableId: number, fromTableId: number, user: JwtUser) {
    const db = this.db;
    if (targetTableId === fromTableId) throw new BadRequestException({ code: 'SAME_TABLE', message: 'Cannot merge a table into itself', messageTh: 'รวมโต๊ะกับตัวเองไม่ได้' });
    const tgtSess = await this.ports.liveSessionForTable(targetTableId);
    if (!tgtSess) throw new BadRequestException({ code: 'NO_SESSION', message: 'Target table has no live session', messageTh: 'โต๊ะปลายทางไม่มีลูกค้า' });
    const srcSess = await this.ports.liveSessionForTable(fromTableId);
    if (!srcSess) throw new BadRequestException({ code: 'NO_SESSION', message: 'Source table has no live session', messageTh: 'โต๊ะต้นทางไม่มีลูกค้า' });
    if (tgtSess.orderMode === 'buffet' || srcSess.orderMode === 'buffet') throw new BadRequestException({ code: 'BUFFET_MERGE', message: 'Buffet tables cannot be merged', messageTh: 'รวมโต๊ะบุฟเฟต์ไม่ได้' });
    const tgt = await this.ports.ensureOpenOrder(targetTableId, user);
    const now = new Date();
    const srcOrders = await db.select().from(dineInOrders).where(and(eq(dineInOrders.sessionId, Number(srcSess.id)), ne(dineInOrders.status, 'closed'), ne(dineInOrders.status, 'cancelled')));
    let moved = 0;
    for (const o of srcOrders) {
      if (Number(o.id) === Number(tgt.id)) continue;
      const r = await db.update(dineInOrderItems).set({ orderId: Number(tgt.id), updatedAt: now }).where(and(eq(dineInOrderItems.orderId, Number(o.id)), ne(dineInOrderItems.kdsStatus, 'voided'))).returning({ id: dineInOrderItems.id });
      moved += r.length;
      await db.update(dineInOrders).set({ status: 'cancelled', notes: `merged into ${tgt.orderNo}`, closedAt: now }).where(eq(dineInOrders.id, Number(o.id)));
    }
    await db.update(tableSessions).set({ status: 'closed', closedAt: now }).where(eq(tableSessions.id, Number(srcSess.id)));
    await db.update(diningTables).set({ status: 'available', updatedAt: now }).where(eq(diningTables.id, fromTableId));
    await this.ports.refreshTotals(Number(tgt.id));
    await this.ports.recomputeOrderStatus(Number(tgt.id));
    return { into_order_no: tgt.orderNo, into_table_id: targetTableId, merged_from_table_id: fromTableId, moved };
  }

  // Guest asks for the bill: freeze the order into bill_requested and flip the table/session state so the
  // floor plan shows it. Totals are refreshed first so the bill amount shown is current.
  async requestBill(orderNo: string, _user: JwtUser) {
    const db = this.db;
    const o = await this.ports.loadOrder(orderNo);
    if (['paid', 'closed', 'cancelled'].includes(String(o.status))) throw new BadRequestException({ code: 'ORDER_CLOSED', message: 'Order closed', messageTh: 'ออเดอร์ปิดแล้ว' });
    const t = await this.ports.refreshTotals(Number(o.id));
    await db.update(dineInOrders).set({ status: 'bill_requested', billRequestedAt: new Date() }).where(eq(dineInOrders.id, o.id));
    if (o.tableId) await db.update(diningTables).set({ status: 'bill_requested', updatedAt: new Date() }).where(eq(diningTables.id, o.tableId));
    if (o.sessionId) await db.update(tableSessions).set({ status: 'bill_requested' }).where(eq(tableSessions.id, o.sessionId));
    return { order_no: orderNo, status: 'bill_requested', total: t.total };
  }

  // ส่งครัว: new → queued, set firedAt
  // Fire the kitchen. With no course/seat → fire ALL pending lines (legacy). With a course → fire only that
  // course's 'new' lines (course-by-course / hold-and-fire); with a seat (POS-9) → fire only that seat's
  // pending lines (serve one guest at a time). course + seat combine. Others stay 'new', off the KDS feed.
  async fire(orderNo: string, user: JwtUser, course?: number, seat?: number) {
    const db = this.db;
    const o = await this.ports.loadOrder(orderNo);
    const now = new Date();
    const where = [eq(dineInOrderItems.orderId, Number(o.id)), eq(dineInOrderItems.kdsStatus, 'new')];
    if (course != null) where.push(eq(dineInOrderItems.course, course));
    if (seat != null) where.push(eq(dineInOrderItems.seat, seat));
    const fired = await db.update(dineInOrderItems).set({ kdsStatus: 'queued', firedAt: now, updatedAt: now }).where(and(...where)).returning({ id: dineInOrderItems.id });
    if (!fired.length && (course != null || seat != null)) {
      if (seat != null && course == null) throw new BadRequestException({ code: 'NO_SEAT_ITEMS', message: `No pending items for seat ${seat}`, messageTh: `ไม่มีรายการรอส่งของที่นั่ง ${seat}` });
      throw new BadRequestException({ code: 'NO_COURSE_ITEMS', message: `No pending items in course ${course}`, messageTh: `ไม่มีรายการรอส่งในคอร์ส ${course}` });
    }
    if (!o.firedAt) await db.update(dineInOrders).set({ firedAt: now }).where(eq(dineInOrders.id, o.id));
    await this.ports.recomputeOrderStatus(Number(o.id));
    return this.ports.getOrder(orderNo, user);
  }

  // POS-9: (re)assign selected (non-voided) line items to a guest seat (null = shared/table). Blocked once
  // the order is settled/closed. Returns the refreshed order view (each line now carries its seat).
  async assignSeat(orderNo: string, itemIds: number[], seat: number | null, user: JwtUser) {
    const db = this.db;
    const o = await this.ports.loadOrder(orderNo);
    if (['paid', 'closed', 'cancelled', 'partially_paid'].includes(String(o.status))) throw new BadRequestException({ code: 'ORDER_CLOSED', message: 'Order is closed', messageTh: 'ออเดอร์ปิดแล้ว' });
    const moved = await db.update(dineInOrderItems).set({ seat, updatedAt: new Date() })
      .where(and(eq(dineInOrderItems.orderId, Number(o.id)), inArray(dineInOrderItems.id, itemIds.map(Number)), ne(dineInOrderItems.kdsStatus, 'voided'))).returning({ id: dineInOrderItems.id });
    if (!moved.length) throw new BadRequestException({ code: 'NO_ITEMS', message: 'No matching items to assign', messageTh: 'ไม่พบรายการที่จะกำหนดที่นั่ง' });
    return this.ports.getOrder(orderNo, user);
  }
}
