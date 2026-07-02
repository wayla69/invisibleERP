import { Inject, Injectable, Optional } from '@nestjs/common';
import { eq, and, gte, lte, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { custPosItems, custPosSales, menuRecipes, menuRecipeLines, menuItems, customerInventory } from '../../database/schema';
import { n, ymd } from '../../database/queries';
import { DemandForecastService } from '../demand-ml/demand-forecast.service';
import type { JwtUser } from '../../common/decorators';

const r2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const r3 = (x: number) => Math.round((Number(x) || 0) * 1000) / 1000;

// Whole-day shift of a YYYY-MM-DD string (UTC-noon anchor avoids DST/edge drift).
function shiftYmd(d: string, days: number): string {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}
// Day-of-week of a business date (0=Sunday). The date string is already the Asia/Bangkok day.
const weekdayOf = (d: string): number => new Date(`${d}T00:00:00Z`).getUTCDay();

// Predictive prep + auto-replenishment ("production plan"). Chains the pieces that a pure POS can't:
//   sales velocity (demand)  →  BOM explosion (recipe)  →  current stock (customer_inventory)
// to answer, for a horizon: how many of each dish to PREP, and which ingredients to BUY (and how much).
//
// Demand model: each dish is forecast by the **demand-ML** engine — it backtests classic models
// (SMA / SES / Holt-trend / weekly seasonal-naive / Croston) walk-forward and auto-selects the most
// accurate by WAPE, so weekly seasonality (weekends ≠ weekdays) and trend are captured and *measured*.
// Dishes with too little history fall back to a transparent **day-of-week average**. Read-only
// suggestions; turning a line into a real PO is a one-click handoff to procurement.
@Injectable()
export class ProductionPlanService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, @Optional() private readonly demand?: DemandForecastService) {}

  async plan(user: JwtUser, opts?: { days?: number; lookback?: number; date?: string }) {
    const db = this.db;
    const tenantId = user.tenantId ?? null;
    const days = Math.max(1, Math.floor(opts?.days ?? 1));          // horizon to prep/buy for
    const lookback = Math.max(1, Math.floor(opts?.lookback ?? 28)); // learning window (days)
    const anchor = opts?.date && /^\d{4}-\d{2}-\d{2}$/.test(opts.date) ? opts.date : ymd(); // plan-from day
    const histStart = shiftYmd(anchor, -lookback); // inclusive
    const histEnd = shiftYmd(anchor, -1);          // day before the anchor, inclusive

    // ── 1. per-dish DAILY sales over the history window (completed sales only) ──
    const soldRows = await db
      .select({ itemId: custPosItems.itemId, d: custPosSales.saleDate, qty: sql<string>`coalesce(sum(${custPosItems.qty}),0)` })
      .from(custPosItems)
      .innerJoin(custPosSales, eq(custPosItems.saleId, custPosSales.id))
      .where(and(eq(custPosSales.tenantId, tenantId as any), gte(custPosSales.saleDate, histStart), lte(custPosSales.saleDate, histEnd), sql`${custPosSales.status}::text = 'Completed'`))
      .groupBy(custPosItems.itemId, custPosSales.saleDate);

    // weekday → qty per dish, and total per dish, plus how many of each weekday the window covered
    const wdSumByDish = new Map<string, number[]>();
    const totalByDish = new Map<string, number>();
    for (const r of soldRows) {
      const sku = String(r.itemId); const q = n(r.qty); const wd = weekdayOf(String(r.d));
      const arr = wdSumByDish.get(sku) ?? [0, 0, 0, 0, 0, 0, 0];
      arr[wd] += q; wdSumByDish.set(sku, arr);
      totalByDish.set(sku, (totalByDish.get(sku) ?? 0) + q);
    }
    const wdOccurrences = [0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < lookback; i++) wdOccurrences[weekdayOf(shiftYmd(histStart, i))]++;
    const targetWeekdays: number[] = [];
    for (let i = 0; i < days; i++) targetWeekdays.push(weekdayOf(shiftYmd(anchor, i)));

    // Forecast = Σ over each target day of that weekday's average (fallback to the overall average when a
    // weekday never occurred in the window). velocity_per_day is the plain overall average (for display).
    const forecastFor = (sku: string): { forecast: number; velocity: number } => {
      const wdSum = wdSumByDish.get(sku) ?? [0, 0, 0, 0, 0, 0, 0];
      const overall = (totalByDish.get(sku) ?? 0) / lookback;
      let f = 0;
      for (const wd of targetWeekdays) f += wdOccurrences[wd] > 0 ? wdSum[wd] / wdOccurrences[wd] : overall;
      return { forecast: Math.ceil(f), velocity: overall };
    };

    // ── recipes (tenant-scoped) + lines + dish names + ingredient stock ──
    const recipes = await db.select().from(menuRecipes).where(and(eq(menuRecipes.tenantId, tenantId as any), eq(menuRecipes.active, true)));
    const recipeIds = recipes.map((r: any) => Number(r.id));
    const lines = recipeIds.length ? await db.select().from(menuRecipeLines).where(inArray(menuRecipeLines.recipeId, recipeIds)) : [];
    const linesByRecipe = new Map<number, any[]>();
    const costByIngredient = new Map<string, number>(); // ingredient → unit cost (from the recipe line) for PO pricing
    for (const l of lines) {
      const k = Number(l.recipeId); (linesByRecipe.get(k) ?? linesByRecipe.set(k, []).get(k))!.push(l);
      const c = n(l.unitCost); if (c > 0 && !costByIngredient.has(String(l.ingredientItemId))) costByIngredient.set(String(l.ingredientItemId), c);
    }
    const mis = await db.select().from(menuItems).where(eq(menuItems.tenantId, tenantId as any));
    const miById = new Map<number, any>(mis.map((m: any) => [Number(m.id), m]));
    const inv = await db.select().from(customerInventory).where(eq(customerInventory.tenantId, tenantId as any));
    const stockBy = new Map<string, { stock: number; reorder: number; reorderQty: number; desc: string | null; uom: string | null }>(
      inv.map((i: any) => [String(i.itemId), { stock: n(i.currentStock), reorder: n(i.reorderPoint), reorderQty: n(i.reorderQty), desc: i.itemDescription, uom: i.uom }]),
    );

    // ── 2. forecast per recipe'd dish + ingredient requirement accumulation ──
    const required = new Map<string, number>(); // ingredient item_id → qty needed for the forecast
    const prep: any[] = [];
    let mlUsed = false;
    for (const rec of recipes) {
      const mi = miById.get(Number(rec.menuItemId));
      const recLines = linesByRecipe.get(Number(rec.id)) ?? [];
      const yld = Math.max(n(rec.yieldQty), 1);
      // Demand-ML first (auto-selected model over the dish's full history); DOW average when too thin.
      let forecast: number; let velocity: number; let model: string; let wape: number | null = null;
      const ml = this.demand ? await this.demand.planForecast(String(rec.sku), days).catch(() => null) : null;
      if (ml) {
        forecast = Math.ceil(ml.forecast.slice(0, days).reduce((a, b) => a + b, 0));
        velocity = r3(ml.forecast.length ? ml.forecast.reduce((a, b) => a + b, 0) / ml.forecast.length : 0);
        model = ml.algorithm; wape = ml.wape; mlUsed = true;
      } else {
        const f = forecastFor(String(rec.sku));
        forecast = f.forecast; velocity = r3(f.velocity); model = 'day-of-week';
      }
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
        velocity_per_day: velocity, forecast_qty: forecast, model, forecast_wape: wape,
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
      let orderQty = 0;
      if (needsOrder) {
        const raw = Math.max(0, req + s.reorder - s.stock);
        orderQty = s.reorderQty > 0 ? Math.ceil(raw / s.reorderQty) * s.reorderQty : Math.ceil(raw);
      }
      return { item_id: itemId, description: s.desc, uom: s.uom, unit_cost: r2(costByIngredient.get(itemId) ?? 0), required: r3(req), stock: r3(s.stock), projected_balance: projected, reorder_point: r3(s.reorder), needs_order: needsOrder, suggested_order_qty: r2(orderQty) };
    }).sort((a, b) => a.projected_balance - b.projected_balance);

    const purchaseOrders = ingredients.filter((i) => i.needs_order);
    return {
      date: anchor, horizon_days: days, lookback_days: lookback,
      forecast_method: mlUsed ? 'demand-ML (auto-selected per dish, day-of-week fallback)' : 'day-of-week',
      summary: {
        dishes: prep.length,
        dishes_to_prep: prep.filter((p) => p.prep_suggestion > 0).length,
        ingredients: ingredients.length,
        ingredients_to_order: purchaseOrders.length,
      },
      prep,
      ingredients,
      // shape ready for a one-click draft PO (POST /api/procurement/pos): item_id + order_qty + unit_price.
      purchase_orders: purchaseOrders.map((i) => ({ item_id: i.item_id, description: i.description, uom: i.uom, order_qty: i.suggested_order_qty, unit_price: i.unit_cost, current_stock: i.stock, required: i.required })),
    };
  }
}
