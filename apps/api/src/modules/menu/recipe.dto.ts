import { z } from 'zod';

export const RecipeLineBody = z.object({
  ingredient_item_id: z.string().min(1),
  ingredient_description: z.string().optional(),
  qty_per: z.number().positive(),
  uom: z.string().optional(),
  unit_cost: z.number().nonnegative().optional(),
});
export const UpsertRecipeBody = z.object({
  yield_qty: z.number().positive().default(1),
  post_cogs: z.boolean().optional(),
  notes: z.string().optional(),
  lines: z.array(RecipeLineBody).min(1),
});
export type UpsertRecipeDto = z.infer<typeof UpsertRecipeBody>;
