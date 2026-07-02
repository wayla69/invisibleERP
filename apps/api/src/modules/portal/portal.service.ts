import { Inject, Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { sql, eq, and, ne, gte, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import {
  tenants, customerInventory, custStockLog, pendingOrders, pendingOrderItems,
  custVariance, custPosSales, orders, orderLines, orderClaims,
} from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { ymd, monthStart, n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

export interface AddInventoryDto {
  item_id: string; item_description?: string; uom?: string;
  current_stock?: number; reorder_point?: number; reorder_qty?: number; notes?: string;
}
export interface UpdateInventoryDto {
  current_stock?: number; reorder_point?: number; reorder_qty?: number; notes?: string;
}
export interface VarianceDto {
  items: { item_id: string; item_description?: string; bom_code?: string; uom?: string; theoretical_use?: number; actual_use: number; reason?: string; reason_code?: string; station?: string }[];
  shift?: string;
}

const HIGH_ANOMALY = 10; // % — major variance threshold
const LOW_ANOMALY = 5;   // % — minor variance threshold

@Injectable()
export class PortalService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
  ) {}

  // ───────────────────── tenant scoping ─────────────────────
  // user.customerName -> tenants.code -> tenants.id (Forbidden if no customer)
  private async tenant(user: JwtUser): Promise<{ id: number; code: string }> {
    if (!user.customerName)
      throw new ForbiddenException({ code: 'NO_TENANT', message: 'User is not tenant-scoped', messageTh: 'บัญชีนี้ไม่ผูกกับร้านค้า' });
    const db = this.db;
    const [t] = await db.select({ id: tenants.id, code: tenants.code }).from(tenants).where(eq(tenants.code, user.customerName)).limit(1);
    if (!t) throw new ForbiddenException({ code: 'NO_TENANT', message: 'Tenant not found', messageTh: 'ไม่พบร้านค้า' });
    return { id: Number(t.id), code: t.code };
  }

  // exposed for sibling services (pos / myerp)
  async tenantId(user: JwtUser) {
    return this.tenant(user);
  }

  // ───────────────────── dashboard (+ auto-reorder) ─────────────────────
  async dashboard(user: JwtUser) {
    const t = await this.tenant(user);
    const db = this.db;
    const today = ymd();
    const mStart = monthStart();
    const notVoided = ne(custPosSales.status, 'Voided');

    const [posDay] = await db.select({
      sales: sql<string>`coalesce(sum(${custPosSales.total}),0)`, orders: sql<string>`count(*)`,
    }).from(custPosSales).where(and(eq(custPosSales.tenantId, t.id), eq(custPosSales.saleDate, today), notVoided));

    const [posMtd] = await db.select({
      sales: sql<string>`coalesce(sum(${custPosSales.total}),0)`, orders: sql<string>`count(*)`,
    }).from(custPosSales).where(and(eq(custPosSales.tenantId, t.id), gte(custPosSales.saleDate, mStart), notVoided));

    const [ord] = await db.select({
      total_orders: sql<string>`count(*)`,
      open_orders: sql<string>`coalesce(sum(case when ${orders.status}::text in ('Pending','Processing','Shipped') then 1 else 0 end),0)`,
    }).from(orders).where(eq(orders.tenantId, t.id));

    const [inv] = await db.select({
      total_items: sql<string>`count(*)`,
      low_stock: sql<string>`coalesce(sum(case when ${customerInventory.currentStock} <= ${customerInventory.reorderPoint} then 1 else 0 end),0)`,
    }).from(customerInventory).where(eq(customerInventory.tenantId, t.id));

    // auto-reorder side-effect (silent like legacy)
    let autoReorder: { pending_no: string; lines: number } | null = null;
    try {
      autoReorder = await this.autoReorder(t.id, t.code, user);
    } catch {
      autoReorder = null;
    }

    return {
      tenant: t.code,
      today_sales: n(posDay?.sales), today_orders: n(posDay?.orders),
      mtd_sales: n(posMtd?.sales), mtd_orders: n(posMtd?.orders),
      total_orders: n(ord?.total_orders), open_orders: n(ord?.open_orders),
      inventory_items: n(inv?.total_items), low_stock_items: n(inv?.low_stock),
      auto_reorder: autoReorder,
    };
  }

  // For customer_inventory rows where current_stock <= reorder_point AND no open Draft pending line:
  // create/get today's Draft pending order (PND-) and insert suggested=final=reorder_qty lines.
  private async autoReorder(tenantId: number, code: string, user: JwtUser): Promise<{ pending_no: string; lines: number } | null> {
    const db = this.db;
    const lowRows = await db.select().from(customerInventory)
      .where(and(eq(customerInventory.tenantId, tenantId), sql`${customerInventory.currentStock} <= ${customerInventory.reorderPoint}`));
    if (!lowRows.length) return null;

    // items already on an open Draft pending line (skip those)
    const draftItems = new Set<string>(
      (await db.select({ itemId: pendingOrderItems.itemId })
        .from(pendingOrderItems)
        .innerJoin(pendingOrders, eq(pendingOrderItems.pendingId, pendingOrders.id))
        .where(and(eq(pendingOrders.tenantId, tenantId), sql`${pendingOrders.status}::text = 'Draft'`)))
        .map((r: any) => r.itemId),
    );

    const toOrder = lowRows.filter((r: any) => !draftItems.has(r.itemId));
    if (!toOrder.length) return null;

    // get/create today's Draft Auto pending order
    const today = ymd();
    let [hdr] = await db.select().from(pendingOrders)
      .where(and(eq(pendingOrders.tenantId, tenantId), sql`${pendingOrders.status}::text = 'Draft'`, sql`${pendingOrders.triggerType}::text = 'Auto'`, sql`(${pendingOrders.createdAt})::date = ${today}`))
      .orderBy(desc(pendingOrders.id)).limit(1);

    if (!hdr) {
      const pendingNo = this.docNo.nextTenantStamped('PND', code);
      [hdr] = await db.insert(pendingOrders).values({
        pendingNo, tenantId, createdAt: new Date(), status: 'Draft', triggerType: 'Auto', notes: 'Auto-generated low-stock reorder',
      }).returning();
    }

    for (const r of toOrder) {
      const qty = n(r.reorderQty);
      await db.insert(pendingOrderItems).values({
        pendingId: Number(hdr!.id), itemId: r.itemId, itemDescription: r.itemDescription,
        suggestedQty: String(qty), finalQty: String(qty), uom: r.uom,
        triggerReason: `Stock ${n(r.currentStock)} <= reorder point ${n(r.reorderPoint)}`,
      });
    }
    const [cnt] = await db.select({ c: sql<string>`count(*)` }).from(pendingOrderItems).where(eq(pendingOrderItems.pendingId, Number(hdr!.id)));
    await db.update(pendingOrders).set({ totalItems: String(n(cnt?.c)) }).where(eq(pendingOrders.id, Number(hdr!.id)));

    return { pending_no: hdr!.pendingNo, lines: toOrder.length };
  }

  // ───────────────────── inventory ─────────────────────
  async listInventory(user: JwtUser) {
    const t = await this.tenant(user);
    const db = this.db;
    const rows = await db.select().from(customerInventory)
      .where(eq(customerInventory.tenantId, t.id)).orderBy(desc(customerInventory.id));
    return {
      items: rows.map((r: any) => ({
        id: Number(r.id), item_id: r.itemId, item_description: r.itemDescription, uom: r.uom,
        current_stock: n(r.currentStock), reorder_point: n(r.reorderPoint), reorder_qty: n(r.reorderQty),
        last_updated: r.lastUpdated, notes: r.notes,
        low_stock: n(r.currentStock) <= n(r.reorderPoint),
      })),
      count: rows.length,
    };
  }

  async addInventory(dto: AddInventoryDto, user: JwtUser) {
    const t = await this.tenant(user);
    const db = this.db;
    const [row] = await db.insert(customerInventory).values({
      tenantId: t.id, itemId: dto.item_id, itemDescription: dto.item_description ?? null, uom: dto.uom ?? null,
      currentStock: String(n(dto.current_stock)), reorderPoint: String(n(dto.reorder_point)), reorderQty: String(n(dto.reorder_qty)),
      lastUpdated: new Date(), notes: dto.notes ?? null,
    }).returning({ id: customerInventory.id });
    return { id: Number(row!.id), item_id: dto.item_id };
  }

  async updateInventory(id: number, dto: UpdateInventoryDto, user: JwtUser) {
    const t = await this.tenant(user);
    const db = this.db;
    const [row] = await db.select().from(customerInventory)
      .where(and(eq(customerInventory.id, id), eq(customerInventory.tenantId, t.id))).limit(1);
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Inventory item not found', messageTh: 'ไม่พบสินค้า' });
    const set: Record<string, unknown> = { lastUpdated: new Date() };
    if (dto.current_stock != null) set.currentStock = String(n(dto.current_stock));
    if (dto.reorder_point != null) set.reorderPoint = String(n(dto.reorder_point));
    if (dto.reorder_qty != null) set.reorderQty = String(n(dto.reorder_qty));
    if (dto.notes != null) set.notes = dto.notes;
    await db.update(customerInventory).set(set).where(eq(customerInventory.id, id));
    return { id, updated: true };
  }

  // ───────────────────── pending orders ─────────────────────
  async listPendingOrders(user: JwtUser) {
    const t = await this.tenant(user);
    const db = this.db;
    const hdrs = await db.select().from(pendingOrders)
      .where(eq(pendingOrders.tenantId, t.id)).orderBy(desc(pendingOrders.id));
    const out = [];
    for (const h of hdrs) {
      const items = await db.select().from(pendingOrderItems).where(eq(pendingOrderItems.pendingId, Number(h.id)));
      out.push({
        pending_no: h.pendingNo, status: h.status, trigger_type: h.triggerType,
        created_at: h.createdAt, total_items: n(h.totalItems), notes: h.notes,
        items: items.map((i: any) => ({
          item_id: i.itemId, item_description: i.itemDescription,
          suggested_qty: n(i.suggestedQty), final_qty: n(i.finalQty), uom: i.uom, trigger_reason: i.triggerReason,
        })),
      });
    }
    return { pending_orders: out, count: out.length };
  }

  async submitPendingOrder(pendingNo: string, user: JwtUser) {
    const t = await this.tenant(user);
    const db = this.db;
    const [h] = await db.select().from(pendingOrders)
      .where(and(eq(pendingOrders.pendingNo, pendingNo), eq(pendingOrders.tenantId, t.id))).limit(1);
    if (!h) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Pending order not found', messageTh: 'ไม่พบใบสั่งซื้อ' });
    await db.update(pendingOrders).set({ status: 'Submitted' }).where(eq(pendingOrders.id, h.id));
    return { pending_no: pendingNo, status: 'Submitted' };
  }

  // ───────────────────── variance (EOD count) ─────────────────────
  async createVariance(dto: VarianceDto, user: JwtUser) {
    const t = await this.tenant(user);
    const db = this.db;
    if (!dto.items?.length) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'No items', messageTh: 'ไม่มีรายการ' });
    const today = ymd();
    const now = new Date();
    const shift = dto.shift ?? 'Day';
    const results: any[] = [];

    await db.transaction(async (tx: any) => {
      for (const it of dto.items) {
        const actual = n(it.actual_use);
        // theoretical = current inventory if not supplied; variance vs theoretical
        const [invRow] = await tx.select().from(customerInventory)
          .where(and(eq(customerInventory.tenantId, t.id), eq(customerInventory.itemId, it.item_id))).limit(1);
        const theoretical = it.theoretical_use != null ? n(it.theoretical_use) : n(invRow?.currentStock);
        const variance = actual - theoretical;
        const variancePct = theoretical !== 0 ? (variance / theoretical) * 100 : 0;

        await tx.insert(custVariance).values({
          varDate: today, tenantId: t.id, itemId: it.item_id, itemDescription: it.item_description ?? invRow?.itemDescription ?? null,
          bomCode: it.bom_code ?? null, theoreticalUse: String(theoretical), actualUse: String(actual),
          variance: String(variance), variancePct: String(Math.round(variancePct * 100) / 100),
          uom: it.uom ?? invRow?.uom ?? null, reason: it.reason ?? null,
          reasonCode: it.reason_code ?? 'OTHER', station: it.station ?? null, shift,
        });

        // overwrite current_stock = actual + log
        if (invRow) {
          await tx.update(customerInventory).set({ currentStock: String(actual), lastUpdated: now }).where(eq(customerInventory.id, invRow.id));
          await tx.insert(custStockLog).values({
            tenantId: t.id, itemId: it.item_id, itemDescription: invRow.itemDescription, logDate: now, logType: 'EOD-Count',
            qtyChange: String(variance), balanceAfter: String(actual), refDoc: `VAR-${today}`, notes: it.reason ?? null, createdBy: user.username,
          });
        }

        const absPct = Math.abs(variancePct);
        const anomaly = absPct >= HIGH_ANOMALY ? 'High' : absPct >= LOW_ANOMALY ? 'Medium' : 'Normal';
        results.push({
          item_id: it.item_id, theoretical_use: theoretical, actual_use: actual,
          variance: Math.round(variance * 100) / 100, variance_pct: Math.round(variancePct * 100) / 100, anomaly,
        });
      }
    });

    return {
      var_date: today, shift, lines: results.length,
      thresholds: { high_pct: HIGH_ANOMALY, low_pct: LOW_ANOMALY },
      results,
    };
  }

  // ───────────────────── track (composite display status) ─────────────────────
  async track(user: JwtUser) {
    const t = await this.tenant(user);
    const db = this.db;
    const rows = await db.select({
      id: orders.id, order_no: orders.orderNo, order_date: orders.orderDate, status: orders.status, estimated_delivery: orders.estimatedDelivery,
    }).from(orders).where(eq(orders.tenantId, t.id)).orderBy(desc(orders.orderNo));

    const out = [];
    for (const o of rows) {
      const lineRows = await db.select({
        status: orderLines.status,
        claimCount: sql<string>`count(${orderClaims.id})`,
      }).from(orderLines)
        .leftJoin(orderClaims, eq(orderClaims.orderLineId, orderLines.id))
        .where(eq(orderLines.orderId, Number(o.id)))
        .groupBy(orderLines.id, orderLines.status);

      const hasClaimed = lineRows.some((l: any) => n(l.claimCount) > 0 || String(l.status) === 'Claimed');
      const hasCompleted = lineRows.some((l: any) => ['Completed', 'Shipped'].includes(String(l.status)));
      let display = String(o.status);
      if (hasClaimed && hasCompleted) display = 'Partial Claim';
      else if (hasClaimed) display = 'Claimed';

      out.push({
        order_no: o.order_no, order_date: o.order_date, status: o.status,
        display_status: display, estimated_delivery: o.estimated_delivery,
      });
    }
    return { orders: out, count: out.length };
  }
}
