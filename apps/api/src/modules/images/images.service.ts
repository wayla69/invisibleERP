import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { itemImages, items } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

// Item images stored as data-URLs in-DB (no object storage). Also stamps items.imageKey.
@Injectable()
export class ImagesService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async upsert(itemId: string, dataUrl: string, user: JwtUser) {
    if (!dataUrl?.startsWith('data:image/')) throw new BadRequestException({ code: 'BAD_IMAGE', message: 'data_url must be a data:image/* URL', messageTh: 'รูปไม่ถูกต้อง' });
    if (dataUrl.length > 3_000_000) throw new BadRequestException({ code: 'IMAGE_TOO_LARGE', message: 'Image too large (max ~2MB)', messageTh: 'รูปใหญ่เกินไป' });
    const db = this.db as any;
    const now = new Date();
    await db.insert(itemImages).values({ itemId, imageKey: itemId, dataUrl, updatedAt: now, updatedBy: user.username })
      .onConflictDoUpdate({ target: itemImages.itemId, set: { dataUrl, imageKey: itemId, updatedAt: now, updatedBy: user.username } });
    await db.update(items).set({ imageKey: itemId }).where(eq(items.itemId, itemId));
    return { item_id: itemId, ok: true };
  }

  async get(itemId: string) {
    const db = this.db as any;
    const [r] = await db.select().from(itemImages).where(eq(itemImages.itemId, itemId)).limit(1);
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No image for item', messageTh: 'ไม่มีรูปสำหรับสินค้านี้' });
    return { item_id: r.itemId, data_url: r.dataUrl, updated_at: r.updatedAt, updated_by: r.updatedBy };
  }

  async list() {
    const db = this.db as any;
    const rows = await db.select({ itemId: itemImages.itemId, updatedAt: itemImages.updatedAt }).from(itemImages).orderBy(desc(itemImages.updatedAt));
    return { items: rows.map((r: any) => ({ item_id: r.itemId, updated_at: r.updatedAt })), count: rows.length };
  }

  async remove(itemId: string) {
    const db = this.db as any;
    await db.delete(itemImages).where(eq(itemImages.itemId, itemId));
    await db.update(items).set({ imageKey: null }).where(eq(items.itemId, itemId));
    return { item_id: itemId, deleted: true };
  }
}
