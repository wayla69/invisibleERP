import { Inject, Injectable } from '@nestjs/common';
import { sql, eq, and, desc, asc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { items, customerInventory, orders, arInvoices } from '../../database/schema';

// Clamp paging to safe bounds (default 50, max 200).
function paging(limit?: string, offset?: string) {
  const l = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const o = Math.max(Number(offset) || 0, 0);
  return { limit: l, offset: o };
}

const num = (v: unknown) => (v == null ? null : Number(v));

// Read-model service for the public REST API (v1). All tenant-scoped tables (customer_inventory,
// orders, ar_invoices) are filtered automatically by RLS via the per-request tenant context; the
// shared `items` catalog has no tenant_id and is returned in full.
@Injectable()
export class PublicApiService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async items(q: { limit?: string; offset?: string; q?: string; category?: string }) {
    const db = this.db as any;
    const { limit, offset } = paging(q.limit, q.offset);
    const conds = [];
    if (q.q) conds.push(sql`(${items.itemId} ilike ${'%' + q.q + '%'} or ${items.itemDescription} ilike ${'%' + q.q + '%'})`);
    if (q.category) conds.push(eq(items.category, q.category));
    const where = conds.length ? and(...conds) : undefined;
    const rows = await db.select({
      item_id: items.itemId, description: items.itemDescription, uom: items.uom,
      unit_price: items.unitPrice, category: items.category,
    }).from(items).where(where).orderBy(asc(items.itemId)).limit(limit).offset(offset);
    const data = rows.map((r: any) => ({ ...r, unit_price: num(r.unit_price) }));
    return this.envelope(data, limit, offset);
  }

  async inventory(q: { limit?: string; offset?: string }) {
    const db = this.db as any;
    const { limit, offset } = paging(q.limit, q.offset);
    const rows = await db.select({
      item_id: customerInventory.itemId, description: customerInventory.itemDescription, uom: customerInventory.uom,
      current_stock: customerInventory.currentStock, reorder_point: customerInventory.reorderPoint,
      reorder_qty: customerInventory.reorderQty, last_updated: customerInventory.lastUpdated,
    }).from(customerInventory).orderBy(asc(customerInventory.itemId)).limit(limit).offset(offset);
    const data = rows.map((r: any) => ({
      ...r, current_stock: num(r.current_stock), reorder_point: num(r.reorder_point), reorder_qty: num(r.reorder_qty),
    }));
    return this.envelope(data, limit, offset);
  }

  async orders(q: { limit?: string; offset?: string; status?: string }) {
    const db = this.db as any;
    const { limit, offset } = paging(q.limit, q.offset);
    const where = q.status ? sql`${orders.status}::text = ${q.status}` : undefined;
    const rows = await db.select({
      order_no: orders.orderNo, order_date: orders.orderDate, status: orders.status,
      currency: orders.currency, created_at: orders.createdAt,
    }).from(orders).where(where).orderBy(desc(orders.orderDate), desc(orders.id)).limit(limit).offset(offset);
    return this.envelope(rows, limit, offset);
  }

  async invoices(q: { limit?: string; offset?: string; status?: string }) {
    const db = this.db as any;
    const { limit, offset } = paging(q.limit, q.offset);
    const where = q.status ? sql`${arInvoices.status}::text = ${q.status}` : undefined;
    const rows = await db.select({
      invoice_no: arInvoices.invoiceNo, invoice_date: arInvoices.invoiceDate, due_date: arInvoices.dueDate,
      order_no: arInvoices.orderNo, amount: arInvoices.amount, paid_amount: arInvoices.paidAmount,
      status: arInvoices.status, currency: arInvoices.currency,
    }).from(arInvoices).where(where).orderBy(desc(arInvoices.invoiceDate), desc(arInvoices.id)).limit(limit).offset(offset);
    const data = rows.map((r: any) => ({
      ...r, amount: num(r.amount), paid_amount: num(r.paid_amount),
      outstanding: num(r.amount) != null ? Number((num(r.amount)! - (num(r.paid_amount) ?? 0)).toFixed(2)) : null,
    }));
    return this.envelope(data, limit, offset);
  }

  private envelope(data: any[], limit: number, offset: number) {
    return { data, pagination: { limit, offset, count: data.length } };
  }
}
