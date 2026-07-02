import { Inject, Injectable } from '@nestjs/common';
import { eq, ne, and, asc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { custPosSales, custPosItems, stockSnapshots } from '../../database/schema';
import { latestSnapshotDate, ymd, n } from '../../database/queries';

@Injectable()
export class ReportsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // GET /api/reports/daily-sales — LEFT JOIN (item-less orders ยังปรากฏ)
  async dailySales(date?: string) {
    const db = this.db;
    const d = date ?? ymd();
    const rows = await db.select({
      Sale_No: custPosSales.saleNo, Sale_Date: custPosSales.saleDate, Total: custPosSales.total,
      Payment_Method: custPosSales.paymentMethod, Status: custPosSales.status,
      Item_Description: custPosItems.itemDescription, Qty: custPosItems.qty,
      Unit_Price: custPosItems.unitPrice, Amount: custPosItems.amount,
    }).from(custPosSales).leftJoin(custPosItems, eq(custPosItems.saleId, custPosSales.id))
      .where(and(eq(custPosSales.saleDate, d), ne(custPosSales.status, 'Voided')))
      .orderBy(asc(custPosSales.saleNo));
    return { date: d, rows: rows.map((r: any) => ({ ...r, Total: n(r.Total), Amount: r.Amount == null ? null : n(r.Amount) })), count: rows.length };
  }

  // GET /api/reports/stock-summary
  async stockSummary() {
    const db = this.db;
    const snap = await latestSnapshotDate(db);
    if (!snap) return { snapshot_date: null, items: [], count: 0 };
    const items = await db.select({
      Item_ID: stockSnapshots.itemId, Item_Description: stockSnapshots.itemDescription, UOM: stockSnapshots.uom,
      AV_QTY: stockSnapshots.avQty, Total_Stock: stockSnapshots.totalStock,
      Temperature_Type: stockSnapshots.temperatureType, Expiry_Date: stockSnapshots.expiryDate,
    }).from(stockSnapshots).where(eq(stockSnapshots.generateDate, snap)).orderBy(stockSnapshots.itemDescription);
    return { snapshot_date: snap.toISOString(), items, count: items.length };
  }
}
