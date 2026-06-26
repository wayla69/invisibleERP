import { z } from 'zod';

export const RecipeLineBody = z.object({
  ingredient_item_id: z.string().min(1),
  ingredient_description: z.string().optional(),
  qty_per: z.number().positive(),
  uom: z.string().optional(),
  unit_cost: z.number().nonnegative().optional(),
  // Step 3 — yield/waste factors (fractions). yield_factor = usable portion after trim (0<..≤1, default 1);
  // waste_factor = expected extra shrink (0≤..<1, default 0). gross_qty = qty_per / (yield_factor − waste_factor).
  yield_factor: z.number().gt(0).max(1).default(1),
  waste_factor: z.number().gte(0).lt(1).default(0),
});
export const UpsertRecipeBody = z.object({
  yield_qty: z.number().positive().default(1),
  post_cogs: z.boolean().optional(),
  notes: z.string().optional(),
  lines: z.array(RecipeLineBody).min(1),
});
export type UpsertRecipeDto = z.infer<typeof UpsertRecipeBody>;
