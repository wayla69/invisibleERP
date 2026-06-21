import { Inject, Injectable } from '@nestjs/common';
import { sql, eq, ne, and, gte, lte, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { custPosSales, custPosItems, apTransactions, stockSnapshots } from '../../database/schema';
import { latestSnapshotDate, ymd, monthStart, n } from '../../database/queries';

@Injectable()
export class DashboardService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // GET /api/dashboard — aggregation (parity-critical: Voided excl, AV_QTY<=0, latest snapshot)
  async getDashboard() {
    const db = this.db as any;
    const today = ymd();
    const mStart = monthStart();
    const notVoided = ne(custPosSales.status, 'Voided');

    const sumOrders = (where: any) =>
      db.select({ sales: sql<string>`coalesce(sum(${custPosSales.total}),0)`, orders: sql<string>`count(*)` }).from(custPosSales).where(where);

    const [todayAgg] = await sumOrders(and(eq(custPosSales.saleDate, today), notVoided));
    const [monthAgg] = await sumOrders(and(gte(custPosSales.saleDate, mStart), lte(custPosSales.saleDate, today), notVoided));

    const snap = await latestSnapshotDate(db);
    let lowStock = 0;
    if (snap) {
      const [r] = await db.select({ c: sql<string>`count(*)` }).from(stockSnapshots)
        .where(and(eq(stockSnapshots.generateDate, snap), sql`${stockSnapshots.avQty} <= 0`));
      lowStock = n(r?.c);
    }

    const [ap] = await db.select({ v: sql<string>`coalesce(sum(${apTransactions.amount} - coalesce(${apTransactions.paidAmount},0)),0)` })
      .from(apTransactions).where(ne(apTransactions.status, 'Paid'));

    const topItems = await db.select({
      Item_Description: custPosItems.itemDescription,
      qty: sql<string>`coalesce(sum(${custPosItems.qty}),0)`,
      revenue: sql<string>`coalesce(sum(${custPosItems.amount}),0)`,
    }).from(custPosItems).innerJoin(custPosSales, eq(custPosItems.saleId, custPosSales.id))
      .where(and(eq(custPosSales.saleDate, today), notVoided))
      .groupBy(custPosItems.itemDescription)
      .orderBy(desc(sql`sum(${custPosItems.amount})`)).limit(5);

    const recent = await db.select({
      Sale_No: custPosSales.saleNo, Sale_Date: custPosSales.saleDate, Total: custPosSales.total,
      Status: custPosSales.status, Payment_Method: custPosSales.paymentMethod,
    }).from(custPosSales).orderBy(desc(custPosSales.saleNo)).limit(5);

    return {
      today: { sales: n(todayAgg?.sales), orders: n(todayAgg?.orders) },
      month: { sales: n(monthAgg?.sales), orders: n(monthAgg?.orders) },
      low_stock_count: lowStock,
      outstanding_ap: n(ap?.v),
      top_items_today: topItems.map((t: any) => ({ Item_Description: t.Item_Description, qty: n(t.qty), revenue: n(t.revenue) })),
      recent_orders: recent.map((r: any) => ({ ...r, Total: n(r.Total) })),
    };
  }

  // GET /api/dashboard/sales-trend
  async getSalesTrend(days: number) {
    const db = this.db as any;
    const cutoff = ymd(new Date(Date.now() - days * 86400_000));
    const rows = await db.select({
      date: custPosSales.saleDate,
      sales: sql<string>`coalesce(sum(${custPosSales.total}),0)`,
      orders: sql<string>`count(*)`,
    }).from(custPosSales)
      .where(and(gte(custPosSales.saleDate, cutoff), ne(custPosSales.status, 'Voided')))
      .groupBy(custPosSales.saleDate).orderBy(custPosSales.saleDate);
    return { days, trend: rows.map((r: any) => ({ date: r.date, sales: n(r.sales), orders: n(r.orders) })) };
  }
}
