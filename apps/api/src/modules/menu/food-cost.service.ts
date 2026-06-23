import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { menuItems, menuRecipes, menuRecipeLines } from '../../database/schema';
import { n } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const r2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const r1 = (x: number) => Math.round((Number(x) || 0) * 10) / 10;

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
}
