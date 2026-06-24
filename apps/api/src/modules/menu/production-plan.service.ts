import { Inject, Injectable } from '@nestjs/common';
import { eq, and, gte, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { custPosItems, custPosSales, menuRecipes, menuRecipeLines, menuItems, customerInventory } from '../../database/schema';
import { n, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const r2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const r3 = (x: number) => Math.round((Number(x) || 0) * 1000) / 1000;

// Predictive prep + auto-replenishment ("production plan"). Chains the pieces that a pure POS can't:
//   sales velocity (demand)  →  BOM explosion (recipe)  →  current stock (customer_inventory)
// to answer two operational questions for a horizon (default: today):
//   1. How many of each dish should the kitchen PREP?  (forecast demand vs what stock can already make)
//   2. Which ingredients must we BUY, and how much?    (requirement vs stock + reorder point)
//
// The demand model here is a transparent average-daily-velocity over a lookback window — honest and
// explainable, and a drop-in point for the ML demand model (`demand-ml`) later. Read-only suggestions;
// turning a suggested order into a real PO is a one-click handoff to the procurement module.
@Injectable()
export class ProductionPlanService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async plan(user: JwtUser, opts?: { days?: number; lookback?: number }) {
    const db = this.db as any;
    const tenantId = user.tenantId ?? null;
    const days = Math.max(1, Math.floor(opts?.days ?? 1));         // horizon to prep/buy for
    const lookback = Math.max(1, Math.floor(opts?.lookback ?? 28)); // velocity window
    const today = ymd();
    const cutoff = ymd(new Date(Date.now() - lookback * 86400_000));

    // ── 1. dish velocity over the lookback window (completed sales only) ──
    const soldRows = await db
      .select({ itemId: custPosItems.itemId, qty: sql<string>`coalesce(sum(${custPosItems.qty}),0)` })
      .from(custPosItems)
      .innerJoin(custPosSales, eq(custPosItems.saleId, custPosSales.id))
      .where(and(eq(custPosSales.tenantId, tenantId as any), gte(custPosSales.saleDate, cutoff), sql`${custPosSales.status}::text = 'Completed'`))
      .groupBy(custPosItems.itemId);
    const soldQty = new Map<string, number>(soldRows.map((r: any) => [String(r.itemId), n(r.qty)]));

    // ── recipes (tenant-scoped) + lines + dish names + ingredient stock ──
    const recipes = await db.select().from(menuRecipes).where(and(eq(menuRecipes.tenantId, tenantId as any), eq(menuRecipes.active, true)));
    const recipeIds = recipes.map((r: any) => Number(r.id));
    const lines = recipeIds.length ? await db.select().from(menuRecipeLines).where(inArray(menuRecipeLines.recipeId, recipeIds)) : [];
    const linesByRecipe = new Map<number, any[]>();
    for (const l of lines) { const k = Number(l.recipeId); (linesByRecipe.get(k) ?? linesByRecipe.set(k, []).get(k))!.push(l); }
    const mis = await db.select().from(menuItems).where(eq(menuItems.tenantId, tenantId as any));
    const miById = new Map<number, any>(mis.map((m: any) => [Number(m.id), m]));
    const inv = await db.select().from(customerInventory).where(eq(customerInventory.tenantId, tenantId as any));
    const stockBy = new Map<string, { stock: number; reorder: number; reorderQty: number; desc: string | null; uom: string | null }>(
      inv.map((i: any) => [String(i.itemId), { stock: n(i.currentStock), reorder: n(i.reorderPoint), reorderQty: n(i.reorderQty), desc: i.itemDescription, uom: i.uom }]),
    );

    // ── 2. forecast per recipe'd dish + ingredient requirement accumulation ──
    const required = new Map<string, number>(); // ingredient item_id → qty needed for the forecast
    const prep: any[] = [];
    for (const rec of recipes) {
      const mi = miById.get(Number(rec.menuItemId));
      const recLines = linesByRecipe.get(Number(rec.id)) ?? [];
      const yld = Math.max(n(rec.yieldQty), 1);
      const velocity = (soldQty.get(String(rec.sku)) ?? 0) / lookback;
      const forecast = Math.ceil(velocity * days);
      // how many servings current stock can already make (the limiting ingredient)
      let canMake = Infinity;
      for (const l of recLines) {
        const perServing = n(l.qtyPer) / yld;
        if (perServing <= 0) continue;
        canMake = Math.min(canMake, Math.floor((stockBy.get(String(l.ingredientItemId))?.stock ?? 0) / perServing));
        required.set(String(l.ingredientItemId), (required.get(String(l.ingredientItemId)) ?? 0) + perServing * forecast);
      }
      // ingredient_capacity = servings this dish's current raw stock could make on its own (indicative —
      // ignores ingredients shared with other dishes; the buy list below is the authoritative shortage).
      const capacity = canMake === Infinity ? null : canMake;
      prep.push({
        sku: rec.sku, name: mi?.name ?? rec.sku,
        velocity_per_day: r3(velocity), forecast_qty: forecast,
        prep_suggestion: forecast,                                  // pre-make to meet forecast demand
        ingredient_capacity: capacity,
        ingredient_short: capacity != null && capacity < forecast,  // can't even cover the forecast alone
      });
    }
    prep.sort((a, b) => b.forecast_qty - a.forecast_qty);

    // ── 3. ingredient buy list: requirement vs stock + reorder point ──
    const ingredients = [...required.entries()].map(([itemId, req]) => {
      const s = stockBy.get(itemId) ?? { stock: 0, reorder: 0, reorderQty: 0, desc: null, uom: null };
      const projected = r3(s.stock - req);
      const needsOrder = projected < s.reorder || projected < 0;
      // bring the balance back up to (requirement + reorder safety); respect the reorder pack size if set
      let orderQty = 0;
      if (needsOrder) {
        const raw = Math.max(0, req + s.reorder - s.stock);
        orderQty = s.reorderQty > 0 ? Math.ceil(raw / s.reorderQty) * s.reorderQty : Math.ceil(raw);
      }
      return { item_id: itemId, description: s.desc, uom: s.uom, required: r3(req), stock: r3(s.stock), projected_balance: projected, reorder_point: r3(s.reorder), needs_order: needsOrder, suggested_order_qty: r2(orderQty) };
    }).sort((a, b) => a.projected_balance - b.projected_balance);

    const purchaseOrders = ingredients.filter((i) => i.needs_order);
    return {
      date: today, horizon_days: days, lookback_days: lookback,
      summary: {
        dishes: prep.length,
        dishes_to_prep: prep.filter((p) => p.prep_suggestion > 0).length,
        ingredients: ingredients.length,
        ingredients_to_order: purchaseOrders.length,
      },
      prep,
      ingredients,
      purchase_orders: purchaseOrders.map((i) => ({ item_id: i.item_id, description: i.description, uom: i.uom, order_qty: i.suggested_order_qty, current_stock: i.stock, required: i.required })),
    };
  }
}
