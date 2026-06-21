import { z } from 'zod';

export const CreateCategoryBody = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  default_useful_life_years: z.number().int().positive().default(5),
  asset_account: z.string().default('1500'),
  accum_dep_account: z.string().default('1590'),
  dep_expense_account: z.string().default('5200'),
});
export type CreateCategoryDto = z.infer<typeof CreateCategoryBody>;

export const AcquireAssetBody = z.object({
  name: z.string().min(1),
  category_id: z.number().int().optional(),
  acquire_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  acquire_cost: z.number().positive(),
  salvage_value: z.number().nonnegative().default(0),
  useful_life_months: z.number().int().positive().optional(),
  acquire_source: z.enum(['cash', 'credit']).default('cash'),
  notes: z.string().optional(),
}).refine((b) => b.useful_life_months != null || b.category_id != null, { message: 'useful_life_months or category_id required' });
export type AcquireAssetDto = z.infer<typeof AcquireAssetBody>;

export const RunDepreciationBody = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/) });

export const DisposeAssetBody = z.object({
  disposal_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  proceeds: z.number().nonnegative().default(0),
  remarks: z.string().optional(),
});
export type DisposeAssetDto = z.infer<typeof DisposeAssetBody>;
