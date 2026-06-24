import { Inject, Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { sql, eq, ne, and, gte, lte, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { custPosSales, custPosItems, tenants, orders, orderLines, loyaltyConfig, loyaltyPoints, loyaltyTxn, arInvoices } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { StatusLogService } from '../../common/status-log.service';
import { isSeriousOverdue } from '../finance/collections.service';
import { ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const n = (v: unknown) => Number(v ?? 0);
const ORDER_STATUSES = ['Pending', 'Processing', 'Shipped', 'Completed', 'Claimed', 'Cancelled'];

export interface CreateOrderDto {
  customer_name?: string;
  items: { item_id: string; item_description?: string; order_qty: number; stock_uom?: string; unit_price: number }[];
}

@Injectable()
export class PosService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly statusLog: StatusLogService,
  ) {}

  // ───────────────────────── READ (Phase 2) ─────────────────────────
  async summary(startDate: string, endDate: string) {
    const db = this.db as any;
    const inRange = and(ne(custPosSales.status, 'Voided'), gte(custPosSales.saleDate, startDate), lte(custPosSales.saleDate, endDate));
    const [s] = await db.select({
      total_orders: sql<string>`count(*)`,
      subtotal: sql<string>`coalesce(sum(${custPosSales.subtotal}),0)`,
      total_discount: sql<string>`coalesce(sum(${custPosSales.discount}),0)`,
      total_tax: sql<string>`coalesce(sum(${custPosSales.taxAmount}),0)`,
      total_sales: sql<string>`coalesce(sum(${custPosSales.total}),0)`,
    }).from(custPosSales).where(inRange);
    const topItems = await db.select({
      Item_Description: custPosItems.itemDescription,
      total_qty: sql<string>`coalesce(sum(${custPosItems.qty}),0)`,
      total_revenue: sql<string>`coalesce(sum(${custPosItems.amount}),0)`,
    }).from(custPosItems).innerJoin(custPosSales, eq(custPosItems.saleId, custPosSales.id))
      .where(inRange).groupBy(custPosItems.itemDescription).orderBy(desc(sql`sum(${custPosItems.amount})`)).limit(10);
    const byPayment = await db.select({
      Payment_Method: custPosSales.paymentMethod, order_count: sql<string>`count(*)`,
      amount: sql<string>`coalesce(sum(${custPosSales.total}),0)`,
    }).from(custPosSales).where(inRange).groupBy(custPosSales.paymentMethod).orderBy(desc(sql`sum(${custPosSales.total})`));
    const totalOrders = n(s?.total_orders);
    const totalSales = n(s?.total_sales);
    return {
      total_orders: totalOrders, subtotal: n(s?.subtotal), total_discount: n(s?.total_discount),
      total_tax: n(s?.total_tax), total_sales: totalSales,
      avg_order_value: totalOrders ? Math.round((totalSales / totalOrders) * 100) / 100 : 0,
      top_items: topItems.map((t: any) => ({ Item_Description: t.Item_Description, total_qty: n(t.total_qty), total_revenue: n(t.total_revenue) })),
      by_payment: byPayment.map((p: any) => ({ Payment_Method: p.Payment_Method, order_count: n(p.order_count), amount: n(p.amount) })),
    };
  }

  async orders(limit: number, offset: number, status?: string) {
    const db = this.db as any;
    const where = status ? sql`${custPosSales.status}::text = ${status}` : undefined;
    const rows = await db.select({
      Sale_No: custPosSales.saleNo, Sale_Date: custPosSales.saleDate, Subtotal: custPosSales.subtotal,
      Discount: custPosSales.discount, Tax_Amount: custPosSales.taxAmount, Total: custPosSales.total,
      Payment_Method: custPosSales.paymentMethod, Status: custPosSales.status,
      Cashier: custPosSales.createdBy, Customer_Name: tenants.code,
    }).from(custPosSales).leftJoin(tenants, eq(custPosSales.tenantId, tenants.id))
      .where(where).orderBy(desc(custPosSales.saleNo)).limit(limit).offset(offset);
    return { orders: rows.map(money), count: rows.length };
  }

  async orderDetail(saleNo: string) {
    const db = this.db as any;
    const [order] = await db.select().from(custPosSales).where(eq(custPosSales.saleNo, saleNo)).limit(1);
    if (!order) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Order not found', messageTh: 'ไม่พบรายการ' });
    const items = await db.select().from(custPosItems).where(eq(custPosItems.saleId, order.id));
    return { order, items };
  }

  async sessions() {
    const db = this.db as any;
    const rows = await db.select({
      Cashier: custPosSales.createdBy, Sale_Date: custPosSales.saleDate,
      session_total: sql<string>`coalesce(sum(${custPosSales.total}),0)`, order_count: sql<string>`count(*)`,
    }).from(custPosSales).where(eq(custPosSales.status, 'Open')).groupBy(custPosSales.createdBy, custPosSales.saleDate);
    return { sessions: rows.map((r: any) => ({ ...r, session_total: n(r.session_total), order_count: n(r.order_count) })) };
  }

  // ───────────────────────── WRITE (Phase 3) ─────────────────────────
  // POST /api/pos/orders — สร้าง sales order (SO-) + credit check + loyalty earn
  async createOrder(dto: CreateOrderDto, user: JwtUser) {
    const db = this.db as any;
    if (!dto.items?.length) throw new BadRequestException({ code: 'BAD_REQUEST', message: 'No items', messageTh: 'ไม่มีรายการสินค้า' });

    // tenant: Customer locked to own; staff picks dto.customer_name
    const custCode = user.role === 'Customer' ? user.customerName : dto.customer_name;
    const total = dto.items.reduce((acc, it) => acc + n(it.order_qty) * n(it.unit_price), 0);
    const orderNo = this.docNo.nextSalesOrder();
    const today = ymd();

    // Everything that touches credit and loyalty runs in ONE transaction. The customer row is locked
    // FOR UPDATE before the AR read, so two concurrent orders for the same customer serialize and cannot
    // both slip under the credit limit (H2). Loyalty earn is an atomic in-tx increment, so the order and
    // its points commit together and concurrent earns never lose an update (H3).
    const pointsEarned = await db.transaction(async (tx: any) => {
      let tenant: any = null;
      if (custCode) [tenant] = await tx.select().from(tenants).where(eq(tenants.code, custCode)).for('update').limit(1);

      // credit check (parity: credit_hold block; outstanding+total > credit_limit block)
      if (tenant) {
        if (tenant.creditHold) throw new ConflictException({ code: 'CREDIT_HOLD', message: 'Customer is on credit hold', messageTh: 'ลูกค้าถูกระงับการสั่งซื้อ' });
        const limit = n(tenant.creditLimit);
        if (limit > 0) {
          const [ar] = await tx.select({ out: sql<string>`coalesce(sum(${arInvoices.amount} - coalesce(${arInvoices.paidAmount},0)),0)` })
            .from(arInvoices).where(and(eq(arInvoices.tenantId, tenant.id), sql`${arInvoices.status}::text <> 'Paid'`));
          if (n(ar?.out) + total > limit)
            throw new ConflictException({ code: 'CREDIT_LIMIT', message: 'Order exceeds credit limit', messageTh: 'เกินวงเงินเครดิต' });
        }
        // Serious-overdue hold (REV-12) — unified with the collections `on_hold` decision: a customer with
        // any invoice 90+ days past due is in default and blocked from new credit orders even within limit.
        // Same FOR-UPDATE'd tenant context, so it serializes with concurrent orders like the limit check.
        const overdue = await tx.select({ due_date: arInvoices.dueDate, out: sql<string>`${arInvoices.amount} - coalesce(${arInvoices.paidAmount},0)` })
          .from(arInvoices).where(and(eq(arInvoices.tenantId, tenant.id), sql`${arInvoices.status}::text <> 'Paid'`));
        let maxOverdueDays = 0;
        for (const r of overdue) {
          if (n(r.out) <= 0.0001 || !r.due_date) continue;
          const d = Math.round((Date.parse(today) - Date.parse(String(r.due_date))) / 86400000);
          if (d > maxOverdueDays) maxOverdueDays = d;
        }
        if (isSeriousOverdue(maxOverdueDays))
          throw new ConflictException({ code: 'CREDIT_OVERDUE', message: `Customer has invoices ${maxOverdueDays} days overdue`, messageTh: 'ลูกค้ามีหนี้ค้างชำระเกินกำหนด (90+ วัน)' });
      }

      const [oh] = await tx.insert(orders).values({
        orderNo, orderDate: today, tenantId: tenant?.id ?? null, status: 'Pending', createdBy: user.username,
      }).returning({ id: orders.id });
      await tx.insert(orderLines).values(dto.items.map((it) => ({
        orderId: Number(oh.id), itemId: it.item_id, itemDescription: it.item_description ?? null,
        orderQty: String(n(it.order_qty)), stockUom: it.stock_uom ?? null,
        unitPrice: String(n(it.unit_price)), totalPrice: String(n(it.order_qty) * n(it.unit_price)),
        status: 'Pending', receivedQty: '0',
      })));

      // loyalty earn (parity: if enabled, points = total * points_per_baht)
      let earned = 0;
      if (tenant) {
        const [cfg] = await tx.select().from(loyaltyConfig).where(eq(loyaltyConfig.id, 1)).limit(1);
        if (cfg?.enabled) {
          earned = total * n(cfg.pointsPerBaht);
          // Atomic relative upsert: balance/lifetime += earned. Correct under concurrency WITHOUT needing
          // the row to pre-exist (a read-then-write absolute set would lose a concurrent earn).
          const [row] = await tx.insert(loyaltyPoints)
            .values({ tenantId: tenant.id, balance: String(earned), lifetime: String(earned) })
            .onConflictDoUpdate({ target: loyaltyPoints.tenantId, set: {
              balance: sql`${loyaltyPoints.balance} + ${earned}::numeric`,
              lifetime: sql`${loyaltyPoints.lifetime} + ${earned}::numeric`,
            } })
            .returning({ balance: loyaltyPoints.balance });
          await tx.insert(loyaltyTxn).values({ tenantId: tenant.id, txnType: 'Earn', points: String(earned), balanceAfter: String(n(row?.balance)), refDoc: orderNo });
        }
      }
      return earned;
    });

    await this.statusLog.log('SO', orderNo, '', 'Pending', user.username);
    return { order_no: orderNo, total, lines: dto.items.length, points_earned: pointsEarned };
  }

  // PATCH /api/orders/{order_no}/status — state machine + est_delivery rule + status log
  async updateOrderStatus(orderNo: string, newStatus: string, estimatedDelivery: string | null, user: JwtUser) {
    const db = this.db as any;
    if (!ORDER_STATUSES.includes(newStatus))
      throw new BadRequestException({ code: 'BAD_STATUS', message: `Invalid status: ${newStatus}`, messageTh: 'สถานะไม่ถูกต้อง' });
    const [order] = await db.select().from(orders).where(eq(orders.orderNo, orderNo)).limit(1);
    if (!order) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Order not found', messageTh: 'ไม่พบคำสั่งซื้อ' });

    // parity: est_delivery เก็บเฉพาะ Processing/Shipped; สถานะอื่น → ล้าง (คงพฤติกรรม V1)
    const est = newStatus === 'Processing' || newStatus === 'Shipped' ? estimatedDelivery ?? null : null;
    await db.update(orders).set({ status: newStatus, estimatedDelivery: est }).where(eq(orders.id, order.id));
    await db.update(orderLines).set({ status: newStatus }).where(eq(orderLines.orderId, order.id));
    await this.statusLog.log('SO', orderNo, order.status ?? '', newStatus, user.username);
    return { order_no: orderNo, status: newStatus, estimated_delivery: est };
  }
}

function money(r: any) {
  return { ...r, Subtotal: n(r.Subtotal), Discount: n(r.Discount), Tax_Amount: n(r.Tax_Amount), Total: n(r.Total) };
}
