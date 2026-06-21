import { Injectable, NotFoundException } from '@nestjs/common';
import type { StockQuery } from '@ierp/shared';
import { InventoryRepository } from './inventory.repository';

const n = (v: unknown) => Number(v ?? 0);

@Injectable()
export class InventoryService {
  constructor(private readonly repo: InventoryRepository) {}

  // GET /api/inventory/stock
  async getStock(q: StockQuery) {
    const snap = await this.repo.latestSnapshotDate();
    if (!snap) return { snapshot_date: null, items: [], total: 0, low_stock_count: 0 };
    const items = await this.repo.stockAtSnapshot(snap, q);
    return {
      snapshot_date: snap.toISOString(),
      items,
      total: items.length,
      low_stock_count: items.filter((i: any) => n(i.AV_QTY) <= 0).length,
    };
  }

  // GET /api/inventory/stock/{item_id}
  async getStockDetail(itemId: string) {
    const snap = await this.repo.latestSnapshotDate();
    const item = snap ? await this.repo.stockItem(snap, itemId) : null;
    if (!item) throw new NotFoundException({ code: 'NOT_FOUND', message: `Item ${itemId} not found`, messageTh: 'ไม่พบสินค้า' });
    const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
    const [recentSales, recentPos, s30] = await Promise.all([
      this.repo.recentSalesForItem(itemId),
      this.repo.recentPosForItem(itemId),
      this.repo.sales30dForItem(itemId, cutoff),
    ]);
    return {
      item,
      snapshot_date: snap!.toISOString(),
      recent_sales: recentSales,
      recent_pos: recentPos,
      sales_30d: { total_qty: n(s30?.total_qty), total_revenue: n(s30?.total_revenue), sale_count: n(s30?.sale_count) },
    };
  }

  // GET /api/inventory/suppliers
  async getSuppliers() {
    const suppliers = await this.repo.suppliers();
    return { suppliers, count: suppliers.length };
  }

  // GET /api/inventory/purchase-orders
  async getPurchaseOrders(limit: number, offset: number, status?: string) {
    const rows = await this.repo.purchaseOrders(limit, offset, status);
    return { purchase_orders: rows.map((r: any) => ({ ...r, Total_Amount: n(r.Total_Amount) })), count: rows.length };
  }
}
