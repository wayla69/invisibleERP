import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, and, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { menuRecipes, menuRecipeLines, menuItems, customerInventory, custStockLog, branchStock, items } from '../../database/schema';
import { n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import type { UpsertRecipeDto } from './recipe.dto';

const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;

@Injectable()
export class RecipeService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private async loadItem(sku: string) {
    const db = this.db as any;
    const [it] = await db.select().from(menuItems).where(eq(menuItems.sku, sku)).limit(1);
    if (!it) throw new NotFoundException({ code: 'ITEM_NOT_FOUND', message: 'Menu item not found', messageTh: 'ไม่พบเมนู' });
    return it;
  }

  // resolve a unit cost: explicit → else the inventory item's unitPrice → else 0
  private async unitCostFor(ingredientItemId: string, explicit?: number): Promise<number> {
    if (explicit != null) return n(explicit);
    const db = this.db as any;
    const [row] = await db.select({ p: items.unitPrice }).from(items).where(eq(items.itemId, ingredientItemId)).limit(1);
    return row ? n(row.p) : 0;
  }

  async upsertRecipe(sku: string, dto: UpsertRecipeDto, _user: JwtUser) {
    const db = this.db as any;
    const it = await this.loadItem(sku);
    const tenantId = it.tenantId ?? null;
    // insert-or-replace by menu_item_id
    const [existing] = await db.select().from(menuRecipes).where(eq(menuRecipes.menuItemId, Number(it.id))).limit(1);
    let recipeId: number;
    if (existing) {
      recipeId = Number(existing.id);
      await db.update(menuRecipes).set({ yieldQty: String(dto.yield_qty), postCogs: dto.post_cogs ?? false, notes: dto.notes ?? null, updatedAt: new Date() }).where(eq(menuRecipes.id, recipeId));
      await db.delete(menuRecipeLines).where(eq(menuRecipeLines.recipeId, recipeId));
    } else {
      const [h] = await db.insert(menuRecipes).values({ tenantId, menuItemId: Number(it.id), sku, yieldQty: String(dto.yield_qty), postCogs: dto.post_cogs ?? false, notes: dto.notes ?? null }).returning({ id: menuRecipes.id });
      recipeId = Number(h.id);
    }
    for (const l of dto.lines) {
      const uc = await this.unitCostFor(l.ingredient_item_id, l.unit_cost);
      await db.insert(menuRecipeLines).values({ tenantId, recipeId, ingredientItemId: l.ingredient_item_id, ingredientDescription: l.ingredient_description ?? null, qtyPer: String(l.qty_per), uom: l.uom ?? null, unitCost: fx(uc, 4) });
    }
    return this.getRecipe(sku, _user);
  }

  async getRecipe(sku: string, _user: JwtUser) {
    const db = this.db as any;
    const it = await this.loadItem(sku);
    const [rec] = await db.select().from(menuRecipes).where(eq(menuRecipes.menuItemId, Number(it.id))).limit(1);
    if (!rec) throw new NotFoundException({ code: 'NO_RECIPE', message: 'No recipe for this item', messageTh: 'ยังไม่มีสูตรสำหรับเมนูนี้' });
    const lines = await db.select().from(menuRecipeLines).where(eq(menuRecipeLines.recipeId, Number(rec.id)));
    const yld = Math.max(n(rec.yieldQty), 1);
    const recipeCost = round4(lines.reduce((a: number, l: any) => a + (n(l.qtyPer) / yld) * n(l.unitCost), 0));
    return { sku, yield_qty: n(rec.yieldQty), post_cogs: rec.postCogs, recipe_cost: recipeCost, lines: lines.map((l: any) => ({ ingredient_item_id: l.ingredientItemId, description: l.ingredientDescription, qty_per: n(l.qtyPer), uom: l.uom, unit_cost: n(l.unitCost) })) };
  }

  async deleteRecipe(sku: string, _user: JwtUser) {
    const db = this.db as any;
    const it = await this.loadItem(sku);
    const [rec] = await db.select().from(menuRecipes).where(eq(menuRecipes.menuItemId, Number(it.id))).limit(1);
    if (rec) { await db.delete(menuRecipeLines).where(eq(menuRecipeLines.recipeId, Number(rec.id))); await db.delete(menuRecipes).where(eq(menuRecipes.id, Number(rec.id))); }
    return { sku, deleted: !!rec };
  }

  async listRecipes(_user: JwtUser) {
    const db = this.db as any;
    const recs = await db.select().from(menuRecipes).orderBy(menuRecipes.sku);
    return { recipes: recs.map((r: any) => ({ sku: r.sku, yield_qty: n(r.yieldQty), post_cogs: r.postCogs })), count: recs.length };
  }

  // ── Availability forecast (proactive layer over the reactive auto-86) ──
  // For every recipe'd dish, how many more servings can the kitchen make from current stock — and which
  // ingredient is the bottleneck. servings_left = floor(min over ingredients of stock / qty-per-serving).
  // Classifies out (0 → should be 86'd) / low (≤ threshold) / ok, and lists low ingredients (≤ reorder pt).
  async availabilityForecast(user: JwtUser, opts?: { low?: number }) {
    const db = this.db as any;
    const tenantId = user.tenantId ?? null;
    const low = Math.max(0, opts?.low ?? 5);
    // Scope to the caller's tenant explicitly (sku/itemId are unique only per tenant; an HQ/bypass caller
    // must not blend another shop's recipes or stock — mirrors explode()).
    const recipes = await db.select().from(menuRecipes).where(and(eq(menuRecipes.tenantId, tenantId as any), eq(menuRecipes.active, true)));
    if (!recipes.length) return { low_threshold: low, summary: { dishes: 0, out: 0, low: 0, ok: 0, low_ingredients: 0 }, items: [], low_ingredients: [] };

    const recipeIds = recipes.map((r: any) => Number(r.id));
    const allLines = await db.select().from(menuRecipeLines).where(inArray(menuRecipeLines.recipeId, recipeIds));
    const linesByRecipe = new Map<number, any[]>();
    for (const l of allLines) { const k = Number(l.recipeId); (linesByRecipe.get(k) ?? linesByRecipe.set(k, []).get(k))!.push(l); }
    const mis = await db.select().from(menuItems).where(eq(menuItems.tenantId, tenantId as any));
    const miById = new Map<number, any>(mis.map((m: any) => [Number(m.id), m]));
    const inv = await db.select().from(customerInventory).where(eq(customerInventory.tenantId, tenantId as any));
    const stockByItem = new Map<string, { stock: number; reorder: number; desc: string | null }>(inv.map((i: any) => [String(i.itemId), { stock: n(i.currentStock), reorder: n(i.reorderPoint), desc: i.itemDescription }]));

    const items: any[] = [];
    for (const r of recipes) {
      const mi = miById.get(Number(r.menuItemId));
      const lines = linesByRecipe.get(Number(r.id)) ?? [];
      const yld = Math.max(n(r.yieldQty), 1);
      let servingsLeft = Infinity;
      let limiting: any = null;
      for (const l of lines) {
        const perServing = n(l.qtyPer) / yld;
        if (perServing <= 0) continue;
        const stock = stockByItem.get(String(l.ingredientItemId))?.stock ?? 0;
        const canMake = Math.floor(stock / perServing);
        if (canMake < servingsLeft) {
          servingsLeft = canMake;
          limiting = { item_id: l.ingredientItemId, description: l.ingredientDescription ?? stockByItem.get(String(l.ingredientItemId))?.desc ?? null, stock: round4(stock), qty_per_serving: round4(perServing) };
        }
      }
      const left = servingsLeft === Infinity ? null : servingsLeft; // no costed ingredient lines → unknown
      const status = left == null ? 'unknown' : left <= 0 ? 'out' : left <= low ? 'low' : 'ok';
      items.push({ sku: r.sku, name: mi?.name ?? r.sku, is_available: mi?.isAvailable ?? true, servings_left: left, status, limiting_ingredient: limiting });
    }
    items.sort((a, b) => (a.servings_left ?? 1e9) - (b.servings_left ?? 1e9));

    // ingredients at/under their reorder point that feed at least one recipe
    const usedItemIds = new Set(allLines.map((l: any) => String(l.ingredientItemId)));
    const lowIngredients = [...stockByItem.entries()]
      .filter(([id, v]) => usedItemIds.has(id) && v.reorder > 0 && v.stock <= v.reorder)
      .map(([id, v]) => ({ item_id: id, description: v.desc, stock: round4(v.stock), reorder_point: round4(v.reorder) }))
      .sort((a, b) => a.stock - b.stock);

    const count = (st: string) => items.filter((i) => i.status === st).length;
    return {
      low_threshold: low,
      summary: { dishes: items.length, out: count('out'), low: count('low'), ok: count('ok'), low_ingredients: lowIngredients.length },
      items,
      low_ingredients: lowIngredients,
    };
  }

  // ── engine (called by sale / return paths; shares the caller's tx) ──
  // Resolve by (tenantId, sku) EXPLICITLY — sku is unique only per tenant (uq_menu_sku), and under an
  // Admin/HQ checkout app.bypass_rls='on' makes RLS see every tenant's recipe, so a bare sku lookup could
  // return another shop's recipe (wrong lines/costs deducted). The known order/sale tenant disambiguates.
  private async explode(db: any, tenantId: number | null, sku: string) {
    const [rec] = await db.select().from(menuRecipes).where(and(eq(menuRecipes.tenantId, tenantId as any), eq(menuRecipes.sku, sku), eq(menuRecipes.active, true))).limit(1);
    if (!rec) return null;
    const lines = await db.select().from(menuRecipeLines).where(eq(menuRecipeLines.recipeId, Number(rec.id)));
    const yld = Math.max(n(rec.yieldQty), 1);
    return { recipeId: Number(rec.id), postCogs: rec.postCogs, lines: lines.map((l: any) => ({ itemId: l.ingredientItemId, desc: l.ingredientDescription, qtyPerServing: n(l.qtyPer) / yld, uom: l.uom, unitCost: n(l.unitCost) })) };
  }

  // deduct ingredients for one sold dish line. Allows negative stock (flags OVERSOLD). Returns COGS cost if post_cogs.
  // branchId (optional): when the sale is tagged to a branch, mirror the deduction into the per-branch ledger
  // (branch_stock) so branch-aware replenishment sees this branch deplete. NULL → rollup-only (untagged remainder).
  async applyDeduction(db: any, tenantId: number | null, sku: string, soldQty: number, saleNo: string, user: JwtUser, branchId: number | null = null): Promise<{ cost: number; deducted: boolean }> {
    const r = await this.explode(db, tenantId, sku);
    if (!r) return { cost: 0, deducted: false };
    let cost = 0;
    for (const l of r.lines) {
      const needed = round4(l.qtyPerServing * soldQty);
      // FOR UPDATE serializes concurrent sales sharing an ingredient → no lost stock decrement (mirrors
      // gift-card/loyalty redeem). The second tx blocks then re-reads the post-decrement balance.
      let [inv] = await db.select().from(customerInventory).where(and(eq(customerInventory.tenantId, tenantId as any), eq(customerInventory.itemId, l.itemId))).for('update').limit(1);
      if (!inv) { [inv] = await db.insert(customerInventory).values({ tenantId, itemId: l.itemId, itemDescription: l.desc ?? l.itemId, uom: l.uom ?? null, currentStock: '0' }).returning(); }
      const after = round4(n(inv.currentStock) - needed);
      await db.update(customerInventory).set({ currentStock: String(after), lastUpdated: new Date() }).where(eq(customerInventory.id, inv.id));
      await db.insert(custStockLog).values({ tenantId, branchId, itemId: l.itemId, itemDescription: l.desc ?? l.itemId, logDate: new Date(), logType: 'Consume', qtyChange: String(-needed), balanceAfter: String(after), refDoc: saleNo, notes: after < 0 ? 'OVERSOLD' : null, createdBy: user.username });
      // mirror into the per-branch ledger. Lock order: rollup row (above) → branch row, to avoid deadlocks.
      if (branchId != null) {
        let [bs] = await db.select().from(branchStock).where(and(eq(branchStock.tenantId, tenantId as any), eq(branchStock.branchId, branchId), eq(branchStock.itemId, l.itemId))).for('update').limit(1);
        if (!bs) { [bs] = await db.insert(branchStock).values({ tenantId, branchId, itemId: l.itemId, itemDescription: l.desc ?? l.itemId, uom: l.uom ?? null, onHand: '0' }).returning(); }
        await db.update(branchStock).set({ onHand: String(round4(n(bs.onHand) - needed)), lastUpdated: new Date() }).where(eq(branchStock.id, bs.id));
      }
      cost = round4(cost + needed * l.unitCost);
    }
    return { cost: r.postCogs ? cost : 0, deducted: true };
  }

  // reverse the deduction on a return (add ingredients back). Returns COGS cost to reverse if post_cogs.
  async reverseDeduction(db: any, tenantId: number | null, sku: string, returnedQty: number, returnNo: string, user: JwtUser, branchId: number | null = null): Promise<{ cost: number; restored: boolean }> {
    const r = await this.explode(db, tenantId, sku);
    if (!r) return { cost: 0, restored: false };
    let cost = 0;
    for (const l of r.lines) {
      const back = round4(l.qtyPerServing * returnedQty);
      const [inv] = await db.select().from(customerInventory).where(and(eq(customerInventory.tenantId, tenantId as any), eq(customerInventory.itemId, l.itemId))).for('update').limit(1);
      if (!inv) continue;
      const after = round4(n(inv.currentStock) + back);
      await db.update(customerInventory).set({ currentStock: String(after), lastUpdated: new Date() }).where(eq(customerInventory.id, inv.id));
      await db.insert(custStockLog).values({ tenantId, branchId, itemId: l.itemId, itemDescription: l.desc ?? l.itemId, logDate: new Date(), logType: 'Consume-Reverse', qtyChange: String(back), balanceAfter: String(after), refDoc: returnNo, createdBy: user.username });
      if (branchId != null) {
        let [bs] = await db.select().from(branchStock).where(and(eq(branchStock.tenantId, tenantId as any), eq(branchStock.branchId, branchId), eq(branchStock.itemId, l.itemId))).for('update').limit(1);
        if (!bs) { [bs] = await db.insert(branchStock).values({ tenantId, branchId, itemId: l.itemId, itemDescription: l.desc ?? l.itemId, uom: l.uom ?? null, onHand: '0' }).returning(); }
        await db.update(branchStock).set({ onHand: String(round4(n(bs.onHand) + back)), lastUpdated: new Date() }).where(eq(branchStock.id, bs.id));
      }
      cost = round4(cost + back * l.unitCost);
    }
    return { cost: r.postCogs ? cost : 0, restored: true };
  }
}
