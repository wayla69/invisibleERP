import { Inject, Injectable, Optional, NotFoundException, ConflictException } from '@nestjs/common';
import { eq, and, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { diningTables, menuRecipes, menuRecipeLines, menuItems, customerInventory } from '../../../database/schema';
import { n } from '../../../database/queries';
import { RealtimeService } from './realtime.service';

// P2a — optimistic concurrency for multi-terminal: a stale `rev` loses with 409 (two servers can't
// silently clobber the same table), plus auto-86 that flips a dish unavailable when an ingredient is short.
@Injectable()
export class LockingService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, @Optional() private readonly realtime?: RealtimeService) {}

  // Guarded table-status write: only succeeds if the caller's rev matches → otherwise 409 STALE_WRITE.
  async setTableStatus(tableId: number, status: string, expectedRev: number) {
    const db = this.db;
    const res = await db.update(diningTables)
      .set({ status: status as typeof diningTables.$inferInsert.status, rev: sql`${diningTables.rev} + 1`, updatedAt: new Date() })
      .where(and(eq(diningTables.id, tableId), eq(diningTables.rev, expectedRev)))
      .returning({ rev: diningTables.rev, status: diningTables.status, tenantId: diningTables.tenantId });
    if (!res.length) {
      const [cur] = await db.select().from(diningTables).where(eq(diningTables.id, tableId)).limit(1);
      if (!cur) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Table not found', messageTh: 'ไม่พบโต๊ะ' });
      throw new ConflictException({ code: 'STALE_WRITE', message: `Table changed by another terminal (current rev ${cur.rev})`, messageTh: 'โต๊ะถูกแก้ไขโดยเครื่องอื่น', current_rev: cur.rev });
    }
    // realtime: push table state to other terminals (SSE)
    this.realtime?.publish({ type: 'table', tenant_id: res[0]!.tenantId, table_id: tableId, status: res[0]!.status, rev: res[0]!.rev, at: new Date().toISOString() });
    return { table_id: tableId, status: res[0]!.status, rev: res[0]!.rev };
  }

  // Auto-86: a dish is unavailable if any recipe ingredient can't cover one serving.
  async recomputeAvailability() {
    const db = this.db;
    const recipes = await db.select().from(menuRecipes).where(eq(menuRecipes.active, true));
    const changed: { sku: string; is_available: boolean }[] = [];
    for (const r of recipes) {
      const lines = await db.select().from(menuRecipeLines).where(eq(menuRecipeLines.recipeId, r.id));
      let available = true;
      for (const l of lines) {
        const [inv] = await db.select().from(customerInventory).where(eq(customerInventory.itemId, l.ingredientItemId)).limit(1);
        const stock = inv ? n(inv.currentStock) : 0;
        if (stock < n(l.qtyPer)) { available = false; break; }
      }
      const [mi] = await db.select().from(menuItems).where(eq(menuItems.id, r.menuItemId)).limit(1);
      if (mi && mi.isAvailable !== available) {
        await db.update(menuItems).set({ isAvailable: available, updatedAt: new Date() }).where(eq(menuItems.id, r.menuItemId));
        changed.push({ sku: mi.sku, is_available: available });
      }
    }
    return { changed, count: changed.length };
  }

  async availability() {
    const db = this.db;
    const rows = await db.select().from(menuItems).where(eq(menuItems.trackStock, true));
    return { items: rows.map((r: any) => ({ sku: r.sku, name: r.name, is_available: r.isAvailable })), count: rows.length };
  }
}
