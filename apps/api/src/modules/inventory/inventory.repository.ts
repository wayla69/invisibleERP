import { Inject, Injectable } from '@nestjs/common';
import { and, eq, like, max, or, sql, desc, ne, gte } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { stockSnapshots, custPosSales, custPosItems, purchaseOrders, poItems, vendors, tenants } from '../../database/schema';
import type { StockQuery } from '@ierp/shared';

@Injectable()
export class InventoryRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async latestSnapshotDate(): Promise<Date | null> {
    const r = await (this.db as any).select({ d: max(stockSnapshots.generateDate) }).from(stockSnapshots);
    return r[0]?.d ? new Date(r[0].d) : null;
  }

  private stockCols = {
    Item_ID: stockSnapshots.itemId,
    Item_Description: stockSnapshots.itemDescription,
    UOM: stockSnapshots.uom,
    Temperature_Type: stockSnapshots.temperatureType,
    AV_QTY: stockSnapshots.avQty,
    Total_Stock: stockSnapshots.totalStock,
    Expiry_Date: stockSnapshots.expiryDate, // เดิม "Expired Date"
    BU_ID: stockSnapshots.buId,
  };

  async stockAtSnapshot(snap: Date, q: StockQuery) {
    const conds = [eq(stockSnapshots.generateDate, snap)];
    if (q.search) conds.push(or(like(stockSnapshots.itemId, `%${q.search}%`), like(stockSnapshots.itemDescription, `%${q.search}%`))!);
    if (q.low_only) conds.push(sql`${stockSnapshots.avQty} <= 0`);
    return (this.db as any).select(this.stockCols).from(stockSnapshots).where(and(...conds)).orderBy(stockSnapshots.avQty).limit(q.limit);
  }

  async stockItem(snap: Date, itemId: string) {
    const r = await (this.db as any).select(this.stockCols).from(stockSnapshots)
      .where(and(eq(stockSnapshots.generateDate, snap), eq(stockSnapshots.itemId, itemId))).limit(1);
    return r[0] ?? null;
  }

  async recentSalesForItem(itemId: string) {
    return (this.db as any).select({
      Sale_No: custPosSales.saleNo, Sale_Date: custPosSales.saleDate, Customer_Name: tenants.code,
      Qty: custPosItems.qty, Unit_Price: custPosItems.unitPrice, Amount: custPosItems.amount,
    }).from(custPosItems).innerJoin(custPosSales, eq(custPosItems.saleId, custPosSales.id))
      .leftJoin(tenants, eq(custPosSales.tenantId, tenants.id))
      .where(and(eq(custPosItems.itemId, itemId), ne(custPosSales.status, 'Voided')))
      .orderBy(desc(custPosSales.saleDate)).limit(15);
  }

  async recentPosForItem(itemId: string) {
    return (this.db as any).select({
      PO_No: purchaseOrders.poNo, PO_Date: purchaseOrders.poDate, Supplier_Name: purchaseOrders.vendorName,
      Status: purchaseOrders.status, Order_Qty: poItems.orderQty, Unit_Price: poItems.unitPrice,
      Amount: poItems.amount, Received_Qty: poItems.receivedQty,
    }).from(poItems).innerJoin(purchaseOrders, eq(poItems.poId, purchaseOrders.id))
      .where(eq(poItems.itemId, itemId)).orderBy(desc(purchaseOrders.poDate)).limit(15);
  }

  async sales30dForItem(itemId: string, cutoff: string) {
    const r = await (this.db as any).select({
      total_qty: sql<string>`coalesce(sum(${custPosItems.qty}),0)`,
      total_revenue: sql<string>`coalesce(sum(${custPosItems.amount}),0)`,
      sale_count: sql<string>`count(*)`,
    }).from(custPosItems).innerJoin(custPosSales, eq(custPosItems.saleId, custPosSales.id))
      .where(and(eq(custPosItems.itemId, itemId), ne(custPosSales.status, 'Voided'), gte(custPosSales.saleDate, cutoff)));
    return r[0];
  }

  async suppliers() {
    return (this.db as any).select({
      Supplier_ID: vendors.vendorCode, Supplier_Name: vendors.name, Contact_Person: vendors.contact,
      Phone: vendors.phone, Email: vendors.email, Payment_Terms: vendors.paymentTerms,
    }).from(vendors).where(eq(vendors.isSupplier, true)).orderBy(vendors.name);
  }

  async purchaseOrders(limit: number, offset: number, status?: string) {
    const where = status ? sql`${purchaseOrders.status}::text = ${status}` : undefined;
    return (this.db as any).select({
      PO_No: purchaseOrders.poNo, PO_Date: purchaseOrders.poDate, Supplier_Name: purchaseOrders.vendorName,
      Status: purchaseOrders.status, Total_Amount: purchaseOrders.totalAmount, Expected_Delivery: purchaseOrders.expectedDate,
    }).from(purchaseOrders).where(where).orderBy(desc(purchaseOrders.poNo)).limit(limit).offset(offset);
  }
}
