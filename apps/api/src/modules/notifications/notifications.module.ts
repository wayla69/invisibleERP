import { Inject, Injectable, Module, Controller, Get, Post, Param, Query } from '@nestjs/common';
import { sql, eq, and, or, ne, asc, desc, lt, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { stockSnapshots, apTransactions, arInvoices, tenants, notifications, notificationReads } from '../../database/schema';
import { latestSnapshotDate, ymd, n } from '../../database/queries';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';

const thb = (v: unknown) => `฿${n(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

@Injectable()
export class NotificationsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // GET /api/notifications — 3 แหล่ง, สตริงไทย + ฿ format (parity-critical contract)
  async list() {
    const db = this.db;
    const today = ymd();
    const alerts: any[] = [];

    // 1) low_stock
    const snap = await latestSnapshotDate(db);
    if (snap) {
      const rows = await db.select({
        Item_ID: stockSnapshots.itemId, Item_Description: stockSnapshots.itemDescription,
        AV_QTY: stockSnapshots.avQty, UOM: stockSnapshots.uom,
      }).from(stockSnapshots).where(and(eq(stockSnapshots.generateDate, snap), sql`${stockSnapshots.avQty} <= 0`))
        .orderBy(asc(stockSnapshots.avQty)).limit(30);
      for (const r of rows) {
        alerts.push({
          type: 'low_stock', severity: 'warning',
          title: r.Item_Description || r.Item_ID,
          subtitle: `Item: ${r.Item_ID} · Qty: ${n(r.AV_QTY)} ${r.UOM ?? ''}`,
          ref_id: r.Item_ID,
        });
      }
    }

    // 2) overdue_ap
    const apRows = await db.select({
      Transaction_ID: apTransactions.txnNo, Creditor_Name: apTransactions.vendorName, Invoice_No: apTransactions.invoiceNo,
      Due_Date: apTransactions.dueDate, Outstanding_Amount: sql<string>`${apTransactions.amount} - coalesce(${apTransactions.paidAmount},0)`,
    }).from(apTransactions).where(and(sql`${apTransactions.status}::text <> 'Paid'`, lt(apTransactions.dueDate, today)))
      .orderBy(asc(apTransactions.dueDate)).limit(30);
    for (const r of apRows) {
      alerts.push({
        type: 'overdue_ap', severity: 'danger',
        title: `AP เกินกำหนด: ${r.Creditor_Name ?? ''}`,
        subtitle: `Invoice ${r.Invoice_No ?? ''} · Due ${r.Due_Date} · ${thb(r.Outstanding_Amount)}`,
        ref_id: r.Transaction_ID, data: { ...r, Outstanding_Amount: n(r.Outstanding_Amount) },
      });
    }

    // 3) overdue_ar
    const arRows = await db.select({
      Invoice_No: arInvoices.invoiceNo, Customer_Name: tenants.code, Due_Date: arInvoices.dueDate,
      Outstanding_Amount: sql<string>`${arInvoices.amount} - coalesce(${arInvoices.paidAmount},0)`,
    }).from(arInvoices).leftJoin(tenants, eq(arInvoices.tenantId, tenants.id))
      .where(and(sql`${arInvoices.status}::text <> 'Paid'`, lt(arInvoices.dueDate, today)))
      .orderBy(asc(arInvoices.dueDate)).limit(30);
    for (const r of arRows) {
      alerts.push({
        type: 'overdue_ar', severity: 'danger',
        title: `AR เกินกำหนด: ${r.Customer_Name ?? ''}`,
        subtitle: `Invoice ${r.Invoice_No ?? ''} · Due ${r.Due_Date} · ${thb(r.Outstanding_Amount)}`,
        ref_id: r.Invoice_No, data: { ...r, Outstanding_Amount: n(r.Outstanding_Amount) },
      });
    }

    const counts = {
      low_stock: alerts.filter((a) => a.type === 'low_stock').length,
      overdue_ap: apRows.length,
      overdue_ar: arRows.length,
      total: alerts.length,
    };
    return { alerts, counts };
  }

  // ── In-app notification inbox (per-user read state) ────────────────────────
  // The notifications table is NOT RLS-scoped (no tenant_id column), so EVERY query
  // here must filter by target_tenant_id = caller's tenant. A row is visible to a
  // user when it targets their tenant AND either is a broadcast (target_role IS NULL)
  // or matches their role. Read state is per-user via notification_reads.
  private visibleTo(user: JwtUser) {
    return and(
      eq(notifications.targetTenantId, user.tenantId as number),
      or(isNull(notifications.targetRole), eq(notifications.targetRole, user.role as any)),
    );
  }

  // GET /api/notifications/inbox — paginated, unread-first then newest-first.
  async inbox(user: JwtUser, opts: { limit?: number; offset?: number; unread_only?: boolean } = {}) {
    const db = this.db;
    if (user.tenantId == null) return { items: [], total: 0, unread_count: 0 };
    const limit = Math.min(Math.max(n(opts.limit) || 20, 1), 100);
    const offset = Math.max(n(opts.offset) || 0, 0);

    const readJoin = and(
      eq(notificationReads.notificationId, notifications.id),
      eq(notificationReads.username, user.username),
    );
    const where = opts.unread_only
      ? and(this.visibleTo(user), isNull(notificationReads.readAt))
      : this.visibleTo(user);

    const rows = await db
      .select({
        id: notifications.id,
        message: notifications.message,
        message_en: notifications.messageEn,
        target_role: notifications.targetRole,
        created_at: notifications.createdAt,
        read_at: notificationReads.readAt,
      })
      .from(notifications)
      .leftJoin(notificationReads, readJoin)
      .where(where)
      .orderBy(asc(sql`(${notificationReads.readAt} is not null)`), desc(notifications.createdAt), desc(notifications.id))
      .limit(limit)
      .offset(offset);

    const items = rows.map((r: any) => ({ ...r, is_read: r.read_at != null }));
    const total = n((await db.select({ c: sql<number>`count(*)` }).from(notifications).where(this.visibleTo(user)))[0]?.c);
    const unread_count = await this.unreadCount(user);
    return { items, total, unread_count };
  }

  // GET /api/notifications/unread-count — for the header bell badge.
  async unreadCount(user: JwtUser) {
    const db = this.db;
    if (user.tenantId == null) return 0;
    const readJoin = and(
      eq(notificationReads.notificationId, notifications.id),
      eq(notificationReads.username, user.username),
    );
    const row = (await db
      .select({ c: sql<number>`count(*)` })
      .from(notifications)
      .leftJoin(notificationReads, readJoin)
      .where(and(this.visibleTo(user), isNull(notificationReads.readAt))))[0];
    return n(row?.c);
  }

  // POST /api/notifications/:id/read — mark one as read for the caller.
  // Guarded: only notifications actually visible to this user can be marked, so a
  // user can never write a read marker for another tenant/role's notification.
  async markRead(user: JwtUser, id: number) {
    const db = this.db;
    if (user.tenantId == null) return { ok: false };
    const visible = (await db.select({ id: notifications.id }).from(notifications)
      .where(and(eq(notifications.id, id), this.visibleTo(user))))[0];
    if (!visible) return { ok: false };
    await db.insert(notificationReads).values({ notificationId: id, username: user.username }).onConflictDoNothing();
    return { ok: true, unread_count: await this.unreadCount(user) };
  }

  // POST /api/notifications/mark-all-read — mark every currently-visible unread one.
  async markAllRead(user: JwtUser) {
    const db = this.db;
    if (user.tenantId == null) return { ok: false, marked: 0 };
    const readJoin = and(
      eq(notificationReads.notificationId, notifications.id),
      eq(notificationReads.username, user.username),
    );
    const unread = await db.select({ id: notifications.id }).from(notifications)
      .leftJoin(notificationReads, readJoin)
      .where(and(this.visibleTo(user), isNull(notificationReads.readAt)));
    if (unread.length)
      await db.insert(notificationReads)
        .values(unread.map((r: any) => ({ notificationId: r.id, username: user.username })))
        .onConflictDoNothing();
    return { ok: true, marked: unread.length, unread_count: 0 };
  }
}

@Controller('api/notifications')
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get()
  @Permissions('dashboard', 'track', 'exec', 'cust_dash')
  list() {
    return this.svc.list();
  }

  // Inbox endpoints — no @Permissions: any authenticated user has a personal inbox,
  // scoped to their own tenant + role (and broadcasts) inside the service.
  @Get('inbox')
  inbox(
    @CurrentUser() u: JwtUser,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('unread_only') unreadOnly?: string,
  ) {
    return this.svc.inbox(u, {
      limit: limit ? +limit : undefined,
      offset: offset ? +offset : undefined,
      unread_only: unreadOnly === '1' || unreadOnly === 'true',
    });
  }

  @Get('unread-count')
  async unreadCount(@CurrentUser() u: JwtUser) {
    return { unread_count: await this.svc.unreadCount(u) };
  }

  @Post('mark-all-read')
  markAllRead(@CurrentUser() u: JwtUser) {
    return this.svc.markAllRead(u);
  }

  @Post(':id/read')
  markRead(@Param('id') id: string, @CurrentUser() u: JwtUser) {
    return this.svc.markRead(u, +id);
  }
}

@Module({ controllers: [NotificationsController], providers: [NotificationsService] })
export class NotificationsModule {}
