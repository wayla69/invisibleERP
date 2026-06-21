import { Inject, Injectable, Module, Controller, Get, Query } from '@nestjs/common';
import { sql, eq, and, ne, asc, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { custPosSales, custPosItems, stockSnapshots } from '../../database/schema';
import { latestSnapshotDate, ymd, n } from '../../database/queries';
import { Permissions } from '../../common/decorators';

@Injectable()
export class ReportsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // GET /api/reports/daily-sales — LEFT JOIN (item-less orders ยังปรากฏ)
  async dailySales(date?: string) {
    const db = this.db as any;
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
    const db = this.db as any;
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

@Controller('api/reports')
export class ReportsController {
  constructor(private readonly svc: ReportsService) {}

  @Get('daily-sales')
  @Permissions('dashboard', 'pos', 'exec')
  daily(@Query('date') date?: string) {
    return this.svc.dailySales(date);
  }

  @Get('stock-summary')
  @Permissions('warehouse', 'dashboard', 'planner')
  stock() {
    return this.svc.stockSummary();
  }
}

@Module({ controllers: [ReportsController], providers: [ReportsService] })
export class ReportsModule {}
