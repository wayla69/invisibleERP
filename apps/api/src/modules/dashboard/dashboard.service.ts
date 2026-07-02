import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { sql, eq, ne, and, gte, lte, lt, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { custPosSales, custPosItems, apTransactions, stockSnapshots, arInvoices, opportunities, purchaseRequests, dashboardLayouts } from '../../database/schema';
import { roleEnum } from '../../database/schema/enums';
import { latestSnapshotDate, ymd, monthStart, n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const ROLES = roleEnum.enumValues as readonly string[];

// Catalog of dashboard widgets. Each is a single KPI computed RLS-scoped over the caller's tenant; `perms`
// gate which roles may see it (a configured layout is still filtered to the viewer's own permissions).
// Add to this map to expose a new widget to the designer — the engine + UI pick it up automatically.
const WIDGETS: Record<string, { label: string; labelEn: string; unit: string; perms: string[] }> = {
  today_sales:   { label: 'ยอดขายวันนี้', labelEn: 'Sales today', unit: 'baht', perms: ['dashboard', 'exec', 'pos'] },
  today_orders:  { label: 'ออเดอร์วันนี้', labelEn: 'Orders today', unit: 'orders', perms: ['dashboard', 'exec', 'pos'] },
  month_sales:   { label: 'ยอดขายเดือนนี้', labelEn: 'Sales MTD', unit: 'baht', perms: ['dashboard', 'exec'] },
  month_orders:  { label: 'ออเดอร์เดือนนี้', labelEn: 'Orders MTD', unit: 'orders', perms: ['dashboard', 'exec'] },
  low_stock:     { label: 'สินค้าสต๊อกต่ำ', labelEn: 'Low-stock items', unit: 'items', perms: ['dashboard', 'warehouse', 'planner'] },
  outstanding_ap:{ label: 'เจ้าหนี้คงค้าง', labelEn: 'Outstanding AP', unit: 'baht', perms: ['creditors', 'exec'] },
  open_ar:       { label: 'ลูกหนี้คงค้าง', labelEn: 'Open AR', unit: 'baht', perms: ['ar', 'exec'] },
  overdue_ar:    { label: 'ลูกหนี้เกินกำหนด', labelEn: 'Overdue AR invoices', unit: 'invoices', perms: ['ar', 'exec'] },
  open_pipeline: { label: 'มูลค่าไปป์ไลน์เปิด', labelEn: 'Open pipeline value', unit: 'baht', perms: ['crm', 'exec', 'marketing'] },
  pipeline_count:{ label: 'จำนวนดีลที่เปิด', labelEn: 'Open opportunities', unit: 'deals', perms: ['crm', 'exec', 'marketing'] },
  open_pr:       { label: 'ใบขอซื้อรออนุมัติ', labelEn: 'Open purchase requisitions', unit: 'PRs', perms: ['procurement', 'exec', 'planner'] },
};
// A sensible starter layout for a role that has no configured layout yet (then filtered to the viewer's perms).
const DEFAULT_WIDGETS = ['today_sales', 'month_sales', 'low_stock', 'outstanding_ap', 'open_ar', 'open_pipeline'];

@Injectable()
export class DashboardService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // GET /api/dashboard — aggregation (parity-critical: Voided excl, AV_QTY<=0, latest snapshot)
  async getDashboard() {
    const db = this.db;
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
    const db = this.db;
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

  // ── Role-based dashboard layouts (Phase 5) ─────────────────────────────────

  // Catalog of available widgets + the role list, for the layout designer.
  widgetCatalog() {
    return {
      widgets: Object.entries(WIDGETS).map(([key, w]) => ({ key, label: w.label, label_en: w.labelEn, unit: w.unit, perms: w.perms })),
      roles: ROLES,
    };
  }

  // Compute one widget's current value over the caller's tenant (RLS-scoped, same as getDashboard()).
  private async evaluateWidget(key: string): Promise<number> {
    const db = this.db;
    const today = ymd();
    const notVoided = ne(custPosSales.status, 'Voided');
    const sales = async (where: any, col: 'sales' | 'orders') => {
      const [r] = await db.select({ sales: sql<string>`coalesce(sum(${custPosSales.total}),0)`, orders: sql<string>`count(*)` }).from(custPosSales).where(where);
      return n(r?.[col]);
    };
    switch (key) {
      case 'today_sales':  return sales(and(eq(custPosSales.saleDate, today), notVoided), 'sales');
      case 'today_orders': return sales(and(eq(custPosSales.saleDate, today), notVoided), 'orders');
      case 'month_sales':  return sales(and(gte(custPosSales.saleDate, monthStart()), lte(custPosSales.saleDate, today), notVoided), 'sales');
      case 'month_orders': return sales(and(gte(custPosSales.saleDate, monthStart()), lte(custPosSales.saleDate, today), notVoided), 'orders');
      case 'low_stock': {
        const snap = await latestSnapshotDate(db);
        if (!snap) return 0;
        const [r] = await db.select({ c: sql<string>`count(*)` }).from(stockSnapshots).where(and(eq(stockSnapshots.generateDate, snap), sql`${stockSnapshots.avQty} <= 0`));
        return n(r?.c);
      }
      case 'outstanding_ap': {
        const [r] = await db.select({ v: sql<string>`coalesce(sum(${apTransactions.amount} - coalesce(${apTransactions.paidAmount},0)),0)` }).from(apTransactions).where(ne(apTransactions.status, 'Paid'));
        return n(r?.v);
      }
      case 'open_ar': {
        const [r] = await db.select({ v: sql<string>`coalesce(sum(${arInvoices.amount} - coalesce(${arInvoices.paidAmount},0)),0)` }).from(arInvoices).where(eq(arInvoices.status, 'Unpaid'));
        return n(r?.v);
      }
      case 'overdue_ar': {
        const [r] = await db.select({ c: sql<string>`count(*)` }).from(arInvoices).where(and(eq(arInvoices.status, 'Unpaid'), lt(arInvoices.dueDate, today)));
        return n(r?.c);
      }
      case 'open_pipeline': {
        const [r] = await db.select({ v: sql<string>`coalesce(sum(${opportunities.expectedValue}),0)` }).from(opportunities).where(eq(opportunities.status, 'Open'));
        return n(r?.v);
      }
      case 'pipeline_count': {
        const [r] = await db.select({ c: sql<string>`count(*)` }).from(opportunities).where(eq(opportunities.status, 'Open'));
        return n(r?.c);
      }
      case 'open_pr': {
        const [r] = await db.select({ c: sql<string>`count(*)` }).from(purchaseRequests).where(eq(purchaseRequests.status, 'Pending'));
        return n(r?.c);
      }
      default: return 0;
    }
  }

  private validRole(role: string) {
    if (!ROLES.includes(role)) throw new BadRequestException({ code: 'BAD_ROLE', message: `Unknown role '${role}'`, messageTh: 'ไม่รู้จักบทบาทนี้' });
  }

  // Fetch the configured widget keys for a role (empty array if none configured).
  async getLayout(role: string, _user: JwtUser) {
    this.validRole(role);
    const db = this.db;
    const [row] = await db.select().from(dashboardLayouts).where(eq(dashboardLayouts.role, role as typeof dashboardLayouts.$inferSelect.role));
    const widgets = Array.isArray(row?.widgets) ? row.widgets : [];
    return { role, widgets, configured: !!row };
  }

  // Admin sets a role's layout (ordered widget keys). Validates the role and every widget key.
  async setLayout(role: string, widgets: unknown, user: JwtUser) {
    this.validRole(role);
    if (!Array.isArray(widgets) || !widgets.every((w) => typeof w === 'string')) throw new BadRequestException({ code: 'BAD_WIDGETS', message: 'widgets must be an array of widget keys', messageTh: 'ต้องเป็นรายการรหัสวิดเจ็ต' });
    for (const k of widgets as string[]) if (!WIDGETS[k]) throw new BadRequestException({ code: 'BAD_WIDGET', message: `Unknown widget '${k}'`, messageTh: `ไม่รู้จักวิดเจ็ต '${k}'` });
    const db = this.db;
    await db.insert(dashboardLayouts).values({ tenantId: user.tenantId ?? null, role: role as typeof dashboardLayouts.$inferInsert.role, widgets, updatedBy: user.username, updatedAt: new Date() })
      .onConflictDoUpdate({ target: [dashboardLayouts.tenantId, dashboardLayouts.role], set: { widgets, updatedBy: user.username, updatedAt: new Date() } });
    return { role, widgets };
  }

  // Resolve the dashboard for the CURRENT user: their role's layout (or the default), filtered to the widgets
  // their own permissions allow, each with its live value. This is what the role-aware dashboard renders.
  async resolveMine(user: JwtUser) {
    const db = this.db;
    const [row] = await db.select().from(dashboardLayouts).where(eq(dashboardLayouts.role, user.role as typeof dashboardLayouts.$inferSelect.role));
    const keys: string[] = Array.isArray(row?.widgets) && row.widgets.length ? row.widgets : DEFAULT_WIDGETS;
    const perms = user.permissions ?? [];
    const allowed = keys.filter((k) => WIDGETS[k] && WIDGETS[k].perms.some((p) => perms.includes(p)));
    const widgets = [];
    for (const k of allowed) {
      const w = WIDGETS[k];
      widgets.push({ key: k, label: w!.label, label_en: w!.labelEn, unit: w!.unit, value: await this.evaluateWidget(k) });
    }
    return { role: user.role, configured: !!row, widgets };
  }
}
