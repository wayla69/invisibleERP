import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, and, or, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { savedViews } from '../../database/schema/saved-views';
import type { JwtUser } from '../../common/decorators';

// Saved views — per-user, per-module saved filter/column presets. A view is visible to its owner always,
// and to everyone in the tenant when `shared`. Tenant isolation is enforced by RLS on top of these queries.
@Injectable()
export class SavedViewsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private fmt(v: any) {
    return { id: Number(v.id), module: v.module, name: v.name, config: v.config ?? {}, shared: v.shared, owner: v.owner, mine: undefined as boolean | undefined };
  }

  async list(module: string | undefined, user: JwtUser) {
    const db = this.db as any;
    const where = [eq(savedViews.owner, user.username), eq(savedViews.shared, true)] as any;
    const rows = await db.select().from(savedViews)
      .where(and(module ? eq(savedViews.module, module) : (undefined as any), or(...where)))
      .orderBy(desc(savedViews.id));
    return { views: rows.map((v: any) => ({ ...this.fmt(v), mine: v.owner === user.username })) };
  }

  async create(dto: { module: string; name: string; config?: object; shared?: boolean }, user: JwtUser) {
    const db = this.db as any;
    const [v] = await db.insert(savedViews).values({
      tenantId: user.tenantId ?? null, owner: user.username, module: dto.module, name: dto.name,
      config: dto.config ?? {}, shared: dto.shared ?? false,
    }).returning();
    return { ...this.fmt(v), mine: true };
  }

  async remove(id: number, user: JwtUser) {
    const db = this.db as any;
    // owner-only delete (a shared view can only be removed by its creator)
    const del = await db.delete(savedViews)
      .where(and(eq(savedViews.id, id), eq(savedViews.owner, user.username)))
      .returning({ id: savedViews.id });
    if (!del.length) throw new NotFoundException({ code: 'VIEW_NOT_FOUND', message: 'View not found', messageTh: 'ไม่พบมุมมองที่บันทึกไว้' });
    return { id, deleted: true };
  }
}
