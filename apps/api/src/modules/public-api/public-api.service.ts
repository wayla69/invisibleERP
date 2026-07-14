import { Inject, Injectable } from '@nestjs/common';
import { sql, eq, and, desc, asc, gte, lte, ne } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { items, customerInventory, orders, arInvoices, custPosSales, custPosItems, customerProfiles, posMembers } from '../../database/schema';
import { ymd } from '../../database/queries';

// Clamp paging to safe bounds (default 50, max 200).
function paging(limit?: string, offset?: string) {
  const l = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const o = Math.max(Number(offset) || 0, 0);
  return { limit: l, offset: o };
}

const num = (v: unknown) => (v == null ? null : Number(v));
const isYmd = (s?: string): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

// Resolve an inclusive [from, to] date window, defaulting to the last `defaultDays` days ending today
// (business date). `to` never exceeds today; `from` never precedes `to - maxDays`.
function dateWindow(from?: string, to?: string, defaultDays = 90, maxDays = 366): { from: string; to: string } {
  const toD = isYmd(to) ? to : ymd();
  const floor = new Date(`${toD}T00:00:00Z`);
  floor.setUTCDate(floor.getUTCDate() - maxDays);
  const floorStr = floor.toISOString().slice(0, 10);
  let fromD: string;
  if (isYmd(from)) fromD = from < floorStr ? floorStr : from;
  else {
    const d = new Date(`${toD}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - defaultDays);
    fromD = d.toISOString().slice(0, 10);
  }
  return { from: fromD, to: toD };
}

// Read-model service for the public REST API (v1). All tenant-scoped tables (customer_inventory,
// orders, ar_invoices) are filtered automatically by RLS via the per-request tenant context; the
// shared `items` catalog has no tenant_id and is returned in full.
@Injectable()
export class PublicApiService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async items(q: { limit?: string; offset?: string; q?: string; category?: string }) {
    const db = this.db;
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
    const db = this.db;
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
    const db = this.db;
    const { limit, offset } = paging(q.limit, q.offset);
    const where = q.status ? sql`${orders.status}::text = ${q.status}` : undefined;
    const rows = await db.select({
      order_no: orders.orderNo, order_date: orders.orderDate, status: orders.status,
      currency: orders.currency, created_at: orders.createdAt,
    }).from(orders).where(where).orderBy(desc(orders.orderDate), desc(orders.id)).limit(limit).offset(offset);
    return this.envelope(rows, limit, offset);
  }

  async invoices(q: { limit?: string; offset?: string; status?: string }) {
    const db = this.db;
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

  // GET /api/v1/sales/daily — per-day revenue over a date window (the MMM target variable). Aggregated from
  // real POS sales (cust_pos_sales), Voided excluded, tenant-scoped by RLS. `group_by=product` breaks the
  // series down by item (joins cust_pos_items and sums line amount/qty). NB there is no native marketing
  // channel/UTM dimension on ERP sales — channel attribution comes from the integrator's own social feeds.
  async salesDaily(q: { from?: string; to?: string; group_by?: string }) {
    const db = this.db;
    const { from, to } = dateWindow(q.from, q.to);
    const dateFilter = and(
      ne(custPosSales.status, 'Voided'),
      gte(custPosSales.saleDate, from),
      lte(custPosSales.saleDate, to),
    );

    if (q.group_by === 'product') {
      const rows = await db.select({
        date: custPosSales.saleDate,
        product: custPosItems.itemDescription,
        revenue: sql<string>`coalesce(sum(${custPosItems.amount}), 0)`,
        units: sql<string>`coalesce(sum(${custPosItems.qty}), 0)`,
      }).from(custPosSales)
        .innerJoin(custPosItems, eq(custPosItems.saleId, custPosSales.id))
        .where(dateFilter)
        .groupBy(custPosSales.saleDate, custPosItems.itemDescription)
        .orderBy(asc(custPosSales.saleDate));
      const data = rows.map((r: any) => ({ date: r.date, product: r.product, revenue: num(r.revenue), units: num(r.units) }));
      return { window: { from, to }, group_by: 'product', data };
    }

    // Default: one row per business day (per-sale grain — do NOT join items, which would multiply `total`).
    const rows = await db.select({
      date: custPosSales.saleDate,
      revenue: sql<string>`coalesce(sum(${custPosSales.total}), 0)`,
      orders: sql<string>`count(*)`,
    }).from(custPosSales)
      .where(dateFilter)
      .groupBy(custPosSales.saleDate)
      .orderBy(asc(custPosSales.saleDate));
    const data = rows.map((r: any) => ({ date: r.date, revenue: num(r.revenue), orders: num(r.orders) }));
    return { window: { from, to }, group_by: 'day', data };
  }

  // GET /api/v1/customers/transactions — per-customer purchase facts for Recency/Frequency/Monetary
  // analysis. The ERP links purchases to an end customer at the loyalty-profile grain (individual POS
  // receipts are not member-stamped), so each row is one loyalty member's rolled-up purchase history
  // (customer_profiles ⋈ pos_members): order_count = Frequency, total_spend = Monetary, last_order_date =
  // Recency anchor. Tenant-scoped by RLS; paginated. `from`/`to` filter on last_order_date.
  async customerTransactions(q: { from?: string; to?: string; limit?: string; offset?: string }) {
    const db = this.db;
    const { limit, offset } = paging(q.limit, q.offset);
    const conds = [];
    if (isYmd(q.from)) conds.push(gte(customerProfiles.lastOrderAt, sql`${q.from}::timestamptz`));
    if (isYmd(q.to)) conds.push(lte(customerProfiles.lastOrderAt, sql`(${q.to}::date + interval '1 day')::timestamptz`));

    const rows = await db.select({
      customer_no: posMembers.memberCode,
      order_count: customerProfiles.totalOrders,
      total_spend: customerProfiles.totalSpend,
      avg_order_value: customerProfiles.avgOrderValue,
      first_order_date: customerProfiles.firstOrderAt,
      last_order_date: customerProfiles.lastOrderAt,
    }).from(customerProfiles)
      .innerJoin(posMembers, eq(posMembers.id, customerProfiles.memberId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(customerProfiles.lastOrderAt))
      .limit(limit).offset(offset);

    const data = rows.map((r: any) => ({
      customer_no: r.customer_no,
      order_count: num(r.order_count) ?? 0,
      total_spend: num(r.total_spend) ?? 0,
      avg_order_value: num(r.avg_order_value),
      first_order_date: r.first_order_date,
      last_order_date: r.last_order_date,
    }));
    return this.envelope(data, limit, offset);
  }

  private envelope(data: any[], limit: number, offset: number) {
    return { data, pagination: { limit, offset, count: data.length } };
  }
}
