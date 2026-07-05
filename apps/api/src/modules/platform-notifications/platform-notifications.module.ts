import { Inject, Injectable, Module, Controller, Get, Post, Param, Query } from '@nestjs/common';
import { sql, eq, and, asc, desc, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { platformNotifications, platformNotificationReads } from '../../database/schema';
import { PlatformAdmin, CurrentUser, type JwtUser } from '../../common/decorators';
import { logger } from '../../observability/logger';

export interface EmitInput {
  type: string;
  title: string;
  body?: string | null;
  tenantId?: number | null;
  refType?: string | null;
  refId?: string | null;
}

// God-facing platform event inbox (migration 0247). A single feed of cross-company events that need a
// platform owner's attention — new signup requests, company suspend/reactivate/provision — with per-god read
// state. Complements the console's live "needs-attention" (which shows current counts): this is the durable
// event LOG with read/unread, so a request that was since handled still shows in history.
@Injectable()
export class PlatformNotificationsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // Best-effort emit — a notification must never break the business action that triggered it.
  async emit(input: EmitInput): Promise<void> {
    try {
      await this.db.insert(platformNotifications).values({
        type: input.type, title: input.title, body: input.body ?? null,
        tenantId: input.tenantId ?? null, refType: input.refType ?? null, refId: input.refId ?? null,
      });
    } catch (e) {
      logger.warn({ err: (e as Error)?.message, type: input.type }, 'platform notification emit failed');
    }
  }

  async inbox(username: string, opts: { limit?: number; offset?: number; unreadOnly?: boolean } = {}) {
    const db = this.db;
    const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 100);
    const offset = Math.max(Number(opts.offset) || 0, 0);
    const readJoin = and(eq(platformNotificationReads.notificationId, platformNotifications.id), eq(platformNotificationReads.username, username));
    const where = opts.unreadOnly ? isNull(platformNotificationReads.readAt) : undefined;
    const rows = await db
      .select({
        id: platformNotifications.id, type: platformNotifications.type, title: platformNotifications.title,
        body: platformNotifications.body, tenant_id: platformNotifications.tenantId,
        ref_type: platformNotifications.refType, ref_id: platformNotifications.refId,
        created_at: platformNotifications.createdAt, read_at: platformNotificationReads.readAt,
      })
      .from(platformNotifications)
      .leftJoin(platformNotificationReads, readJoin)
      .where(where)
      .orderBy(asc(sql`(${platformNotificationReads.readAt} is not null)`), desc(platformNotifications.createdAt), desc(platformNotifications.id))
      .limit(limit).offset(offset);
    const items = rows.map((r) => ({ ...r, is_read: r.read_at != null }));
    const total = Number((await db.select({ c: sql<number>`count(*)` }).from(platformNotifications))[0]?.c ?? 0);
    return { items, total, unread_count: await this.unreadCount(username) };
  }

  async unreadCount(username: string): Promise<number> {
    const readJoin = and(eq(platformNotificationReads.notificationId, platformNotifications.id), eq(platformNotificationReads.username, username));
    const row = (await this.db
      .select({ c: sql<number>`count(*)` })
      .from(platformNotifications)
      .leftJoin(platformNotificationReads, readJoin)
      .where(isNull(platformNotificationReads.readAt)))[0];
    return Number(row?.c ?? 0);
  }

  async markRead(username: string, id: number) {
    await this.db.insert(platformNotificationReads).values({ notificationId: id, username }).onConflictDoNothing();
    return { ok: true, unread_count: await this.unreadCount(username) };
  }

  async markAllRead(username: string) {
    const readJoin = and(eq(platformNotificationReads.notificationId, platformNotifications.id), eq(platformNotificationReads.username, username));
    const unread = await this.db.select({ id: platformNotifications.id }).from(platformNotifications)
      .leftJoin(platformNotificationReads, readJoin).where(isNull(platformNotificationReads.readAt));
    if (unread.length)
      await this.db.insert(platformNotificationReads).values(unread.map((r) => ({ notificationId: Number(r.id), username }))).onConflictDoNothing();
    return { ok: true, marked: unread.length, unread_count: 0 };
  }
}

@Controller('api/admin/notifications')
export class PlatformNotificationsController {
  constructor(private readonly svc: PlatformNotificationsService) {}

  @Get('unread-count') @PlatformAdmin()
  async unreadCount(@CurrentUser() u: JwtUser) {
    return { unread_count: await this.svc.unreadCount(u.username) };
  }

  @Post('mark-all-read') @PlatformAdmin()
  markAllRead(@CurrentUser() u: JwtUser) {
    return this.svc.markAllRead(u.username);
  }

  @Post(':id/read') @PlatformAdmin()
  markRead(@Param('id') id: string, @CurrentUser() u: JwtUser) {
    return this.svc.markRead(u.username, Number(id));
  }

  @Get() @PlatformAdmin()
  inbox(@CurrentUser() u: JwtUser, @Query('limit') limit?: string, @Query('offset') offset?: string, @Query('unread_only') unreadOnly?: string) {
    return this.svc.inbox(u.username, { limit: limit ? +limit : undefined, offset: offset ? +offset : undefined, unreadOnly: unreadOnly === '1' || unreadOnly === 'true' });
  }
}

@Module({
  controllers: [PlatformNotificationsController],
  providers: [PlatformNotificationsService],
  exports: [PlatformNotificationsService],
})
export class PlatformNotificationsModule {}
