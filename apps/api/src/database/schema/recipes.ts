// POS Tier 2 — Recipe / BOM ingredient deduction (ตัดวัตถุดิบตามสูตร).
// menu_recipes = 1:1 with a menu_items row; lines = ingredients consumed per serving.
// Selling a dish deducts these from customer_inventory (quantity ledger via cust_stock_log).
import { pgTable, bigserial, bigint, text, numeric, boolean, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { menuItems } from './menu';

export const menuRecipes = pgTable('menu_recipes', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  menuItemId: bigint('menu_item_id', { mode: 'number' }).notNull().references(() => menuItems.id),
  sku: text('sku').notNull(),                 // denorm menu_items.sku (join key from cust_pos_items.item_id)
  yieldQty: numeric('yield_qty').notNull().default('1'),
  postCogs: boolean('post_cogs').notNull().default(false),
  active: boolean('active').notNull().default(true),
  notes: text('notes'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqRecipeItem: unique('uq_recipe_menu_item').on(t.menuItemId), bySku: index('idx_recipe_sku').on(t.tenantId, t.sku) }));

export const menuRecipeLines = pgTable('menu_recipe_lines', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  recipeId: bigint('recipe_id', { mode: 'number' }).notNull().references(() => menuRecipes.id),
  ingredientItemId: text('ingredient_item_id').notNull(),  // → customer_inventory.item_id
  ingredientDescription: text('ingredient_description'),
  qtyPer: numeric('qty_per').notNull(),       // per ONE serving (divided by yield at explode time)
  uom: text('uom'),
  unitCost: numeric('unit_cost', { precision: 14, scale: 4 }),
}, (t) => ({ byRecipe: index('idx_recipe_line_recipe').on(t.recipeId) }));

export type MenuRecipe = typeof menuRecipes.$inferSelect;
export type MenuRecipeLine = typeof menuRecipeLines.$inferSelect;
