import { Inject, Injectable } from '@nestjs/common';
import { eq, and, gte, lte } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { menuItems, menuRecipes, menuRecipeLines, custVariance, items as inventoryItems } from '../../database/schema';
import { n, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const r2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const r1 = (x: number) => Math.round((Number(x) || 0) * 10) / 10;
// variance anomaly bands (|variance %| of theoretical usage)
const HIGH_VAR = 10, MED_VAR = 5;

// Food-cost / margin analytics — theoretical (recipe-based). Computes per-item cost from the recipe
// (falling back to menu_items.cost), margin %, food-cost %, and an ingredient cost-contribution view.
// Actual-vs-physical variance (stock counts) is a separate inventory feature; this is the menu-engineering layer.
@Injectable()
export class FoodCostService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private async recipeCostByItem() {
    const db = this.db as any;
    const recs = await db.select().from(menuRecipes);
    const lines = await db.select().from(menuRecipeLines);
    const byRecipe = new Map<number, any[]>();
    for (const l of lines) { const k = Number(l.recipeId); if (!byRecipe.has(k)) byRecipe.set(k, []); byRecipe.get(k)!.push(l); }
    const costByItem = new Map<number, number>();
    for (const rec of recs) {
      const yld = Math.max(n(rec.yieldQty), 1);
      const cost = (byRecipe.get(Number(rec.id)) ?? []).reduce((a: number, l: any) => a + (n(l.qtyPer) / yld) * n(l.unitCost), 0);
      costByItem.set(Number(rec.menuItemId), r2(cost));
    }
    return costByItem;
  }

  // per-item price / cost / margin %, with a menu-level summary against a food-cost target
  async menuMargins(_user: JwtUser, targetPct = 35) {
    const db = this.db as any;
    const its = await db.select().from(menuItems).where(eq(menuItems.active, true));
    const recipeCost = await this.recipeCostByItem();
    const items = its.map((it: any) => {
      const hasRecipe = recipeCost.has(Number(it.id));
      const cost = hasRecipe ? recipeCost.get(Number(it.id))! : (it.cost != null ? n(it.cost) : 0);
      const price = n(it.price);
      const margin = r2(price - cost);
      return {
        sku: it.sku, name: it.name, price, cost, margin,
        margin_pct: price > 0 ? r1((margin / price) * 100) : 0,
        food_cost_pct: price > 0 ? r1((cost / price) * 100) : 0,
        has_recipe: hasRecipe, costed: hasRecipe || (it.cost != null && n(it.cost) > 0),
      };
    }).sort((a: any, b: any) => b.food_cost_pct - a.food_cost_pct);
    const priced = items.filter((i: any) => i.price > 0 && i.costed);
    const avgFoodCost = priced.length ? r1(priced.reduce((a: number, i: any) => a + i.food_cost_pct, 0) / priced.length) : 0;
    return {
      target_pct: targetPct,
      summary: { items: items.length, costed: priced.length, uncosted: items.length - priced.length, avg_food_cost_pct: avgFoodCost, over_target: priced.filter((i: any) => i.food_cost_pct > targetPct).length },
      items,
    };
  }

  // which ingredients drive cost across the menu (theoretical cost-per-serving summed over recipes using them)
  async ingredientCost(_user: JwtUser) {
    const db = this.db as any;
    const recs = await db.select().from(menuRecipes);
    const yldByRecipe = new Map<number, number>(recs.map((r: any) => [Number(r.id), Math.max(n(r.yieldQty), 1)]));
    const lines = await db.select().from(menuRecipeLines);
    const agg = new Map<string, { ingredient_item_id: string; description: string | null; cost: number; recipes_using: number }>();
    for (const l of lines) {
      const yld = yldByRecipe.get(Number(l.recipeId)) ?? 1;
      const perServing = (n(l.qtyPer) / yld) * n(l.unitCost);
      const key = l.ingredientItemId;
      const e = agg.get(key) ?? { ingredient_item_id: key, description: l.ingredientDescription ?? null, cost: 0, recipes_using: 0 };
      e.cost = r2(e.cost + perServing); e.recipes_using += 1;
      agg.set(key, e);
    }
    return { ingredients: [...agg.values()].sort((a, b) => b.cost - a.cost) };
  }

  // Actual-vs-theoretical food-cost VARIANCE (the deferred inventory layer). EOD physical counts record a
  // per-ingredient quantity variance (actual − theoretical use) in cust_variance; this VALUES that variance
  // at the ingredient's cost and rolls it up over a date window, so a manager sees the baht impact of
  // over-portioning / waste / shrinkage beyond what recipes predicted, plus the % off theoretical.
  // Sign: variance > 0 ⇒ used MORE than the recipe theoretical ⇒ unfavorable (extra cost).
  async foodCostVariance(_user: JwtUser, opts?: { from?: string; to?: string }) {
    const db = this.db as any;
    const to = opts?.to ?? ymd();
    const from = opts?.from ?? to; // default: a single day
    // cost basis per ingredient: the item master cost, falling back to a recipe line's unit cost
    const invRows = await db.select({ itemId: inventoryItems.itemId, cost: inventoryItems.unitPrice }).from(inventoryItems);
    const costByItem = new Map<string, number>(invRows.map((r: any) => [String(r.itemId), n(r.cost)]));
    const recLines = await db.select({ itemId: menuRecipeLines.ingredientItemId, cost: menuRecipeLines.unitCost }).from(menuRecipeLines);
    for (const l of recLines) { const k = String(l.itemId); if (!costByItem.get(k)) costByItem.set(k, n(l.cost)); }

    const rows = await db.select().from(custVariance).where(and(gte(custVariance.varDate, from), lte(custVariance.varDate, to)));
    // aggregate per ingredient across the window
    const byItem = new Map<string, { item_id: string; description: string | null; theoretical_use: number; actual_use: number; variance_qty: number; unit_cost: number }>();
    for (const v of rows) {
      const k = String(v.itemId);
      const e = byItem.get(k) ?? { item_id: k, description: v.itemDescription ?? null, theoretical_use: 0, actual_use: 0, variance_qty: 0, unit_cost: costByItem.get(k) ?? 0 };
      e.theoretical_use = r2(e.theoretical_use + n(v.theoreticalUse));
      e.actual_use = r2(e.actual_use + n(v.actualUse));
      e.variance_qty = r2(e.variance_qty + n(v.variance));
      byItem.set(k, e);
    }
    const items = [...byItem.values()].map((e) => {
      const theoretical_cost = r2(e.theoretical_use * e.unit_cost);
      const actual_cost = r2(e.actual_use * e.unit_cost);
      const variance_cost = r2(e.variance_qty * e.unit_cost);
      const variance_pct = e.theoretical_use !== 0 ? r1((e.variance_qty / e.theoretical_use) * 100) : 0;
      const absPct = Math.abs(variance_pct);
      return {
        item_id: e.item_id, description: e.description, unit_cost: e.unit_cost,
        theoretical_use: e.theoretical_use, actual_use: e.actual_use, variance_qty: e.variance_qty,
        theoretical_cost, actual_cost, variance_cost,
        variance_pct, anomaly: absPct >= HIGH_VAR ? 'High' : absPct >= MED_VAR ? 'Medium' : 'Normal',
      };
    }).sort((a, b) => Math.abs(b.variance_cost) - Math.abs(a.variance_cost));

    const theoreticalCost = r2(items.reduce((a, i) => a + i.theoretical_cost, 0));
    const actualCost = r2(items.reduce((a, i) => a + i.actual_cost, 0));
    const varianceCost = r2(items.reduce((a, i) => a + i.variance_cost, 0));
    return {
      from, to,
      summary: {
        items: items.length,
        theoretical_cost: theoreticalCost,
        actual_cost: actualCost,
        variance_cost: varianceCost,                                            // + = unfavorable (extra usage cost)
        variance_pct: theoreticalCost !== 0 ? r1((varianceCost / theoreticalCost) * 100) : 0,
        unfavorable_cost: r2(items.filter((i) => i.variance_cost > 0).reduce((a, i) => a + i.variance_cost, 0)),
        favorable_cost: r2(items.filter((i) => i.variance_cost < 0).reduce((a, i) => a + i.variance_cost, 0)),
        anomalies: items.filter((i) => i.anomaly !== 'Normal').length,
      },
      items,
    };
  }
}
