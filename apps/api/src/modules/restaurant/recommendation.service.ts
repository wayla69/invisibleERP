import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, isNotNull, ne, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { dineInOrders, dineInOrderItems, menuItems, memberDiningProfiles } from '../../database/schema';
import { n } from '../../database/queries';

export type RecommendMode = 'manual' | 'behavior' | 'popular_low_cost';

// Recommendation engine (bounded responsibility, own service — not folded into MenuService): resolves the
// SKU set the diner menu should highlight as "เมนูแนะนำ" for a given per-tenant strategy. Read-only
// analytics over the F&B tables; assumes it runs inside the request tenant tx (RLS-scoped).
@Injectable()
export class RecommendationService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // Returns the recommended SKUs for a mode, or null for 'manual' (the caller keeps the per-item flags).
  async recommendedSkus(mode: RecommendMode, count = 6): Promise<Set<string> | null> {
    if (mode === 'manual') return null;
    const top = mode === 'behavior' ? await this.byBehavior(count) : await this.byPopularLowCost(count);
    return new Set(top);
  }

  private since(days = 30): Date {
    return new Date(Date.now() - days * 86_400_000);
  }

  // "ตามพฤติกรรมการกินของลูกค้า" — dishes members actually order most, from member-attributed dine-in
  // history, tie-broken by how many member dining-profiles curate the dish as a favourite. Falls back to
  // overall popularity when there is no member signal yet (a fresh shop).
  private async byBehavior(count: number): Promise<string[]> {
    const db = this.db;
    const rows = await db
      .select({ sku: dineInOrderItems.itemId, qty: sql<number>`sum(${dineInOrderItems.qty})` })
      .from(dineInOrderItems)
      .innerJoin(dineInOrders, eq(dineInOrderItems.orderId, dineInOrders.id))
      .where(and(
        isNotNull(dineInOrders.memberId),
        isNotNull(dineInOrderItems.itemId),
        eq(dineInOrderItems.isBuffet, false),
        ne(dineInOrderItems.kdsStatus, 'voided'),
        gte(dineInOrderItems.createdAt, this.since()),
      ))
      .groupBy(dineInOrderItems.itemId);
    const scored = new Map<string, number>();
    for (const r of rows) if (r.sku) scored.set(r.sku, n(r.qty));
    // curated favourites nudge (each member who lists a dish adds a small bump)
    const favRows = await db.select({ fav: memberDiningProfiles.favoriteMenus }).from(memberDiningProfiles);
    const nameToSku = await this.nameToSku();
    for (const fr of favRows) {
      for (const name of (Array.isArray(fr.fav) ? fr.fav : []) as string[]) {
        const sku = nameToSku.get(String(name).trim().toLowerCase());
        if (sku) scored.set(sku, (scored.get(sku) ?? 0) + 0.5);
      }
    }
    const ranked = [...scored.entries()].sort((a, b) => b[1] - a[1]).map(([sku]) => sku);
    return ranked.length ? ranked.slice(0, count) : this.byPopularLowCost(count);
  }

  // "เมนูที่นิยมและต้นทุนต่ำ" — best sellers weighted by unit margin (price − cost). Popularity and margin
  // are each min-max normalised to [0,1] and averaged so neither dimension dominates.
  private async byPopularLowCost(count: number): Promise<string[]> {
    const db = this.db;
    const sales = await db
      .select({ sku: dineInOrderItems.itemId, qty: sql<number>`sum(${dineInOrderItems.qty})` })
      .from(dineInOrderItems)
      .where(and(
        isNotNull(dineInOrderItems.itemId),
        eq(dineInOrderItems.isBuffet, false),
        ne(dineInOrderItems.kdsStatus, 'voided'),
        gte(dineInOrderItems.createdAt, this.since()),
      ))
      .groupBy(dineInOrderItems.itemId);
    const qtyBySku = new Map<string, number>();
    for (const r of sales) if (r.sku) qtyBySku.set(r.sku, n(r.qty));
    if (!qtyBySku.size) return [];
    const items = await db.select({ sku: menuItems.sku, price: menuItems.price, cost: menuItems.cost }).from(menuItems).where(eq(menuItems.active, true));
    const margin = new Map<string, number>();
    for (const it of items) margin.set(it.sku, Math.max(0, n(it.price) - n(it.cost)));
    const skus = [...qtyBySku.keys()].filter((s) => margin.has(s));
    const norm = (vals: number[]) => { const mx = Math.max(...vals, 0), mn = Math.min(...vals, 0); return (v: number) => (mx > mn ? (v - mn) / (mx - mn) : 0); };
    const nQty = norm(skus.map((s) => qtyBySku.get(s)!));
    const nMar = norm(skus.map((s) => margin.get(s)!));
    return skus
      .map((s) => ({ s, score: 0.5 * nQty(qtyBySku.get(s)!) + 0.5 * nMar(margin.get(s)!) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, count)
      .map((x) => x.s);
  }

  private async nameToSku(): Promise<Map<string, string>> {
    const rows = await this.db.select({ sku: menuItems.sku, name: menuItems.name, nameEn: menuItems.nameEn }).from(menuItems).where(eq(menuItems.active, true));
    const m = new Map<string, string>();
    for (const r of rows) {
      m.set(String(r.name).trim().toLowerCase(), r.sku);
      if (r.nameEn) m.set(String(r.nameEn).trim().toLowerCase(), r.sku);
    }
    return m;
  }
}
