import { z } from 'zod';

export const CreateCategoryBody = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  name_en: z.string().optional(),
  color: z.string().optional(),
  sort: z.number().int().optional(),
});
export type CreateCategoryDto = z.infer<typeof CreateCategoryBody>;

export const CreateItemBody = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  name_en: z.string().optional(),
  category_id: z.number().int().optional(),
  type: z.enum(['food', 'drink', 'retail', 'combo']).default('food'),
  price: z.number().nonnegative(),
  cost: z.number().nonnegative().optional(),
  station_code: z.string().optional(),
  prep_minutes: z.number().int().nonnegative().optional(),
  tax_type: z.enum(['standard', 'exempt', 'zero']).default('standard'),
  track_stock: z.boolean().optional(),
  image_url: z.string().optional(),
  description: z.string().optional(),
  sort: z.number().int().optional(),
  // day-parting (Asia/Bangkok): 7-char day mask (idx0=Sun) + minutes-from-midnight window; null = always
  avail_days: z.string().regex(/^[01]{7}$/).optional().nullable(),
  avail_start_min: z.number().int().min(0).max(1440).optional().nullable(),
  avail_end_min: z.number().int().min(0).max(1440).optional().nullable(),
  modifier_group_ids: z.array(z.number().int()).optional(),
});
export type CreateItemDto = z.infer<typeof CreateItemBody>;

export const UpdateItemBody = z.object({
  name: z.string().min(1).optional(),
  name_en: z.string().optional(),
  category_id: z.number().int().optional(),
  price: z.number().nonnegative().optional(),
  cost: z.number().nonnegative().optional(),
  station_code: z.string().optional(),
  prep_minutes: z.number().int().nonnegative().optional(),
  tax_type: z.enum(['standard', 'exempt', 'zero']).optional(),
  track_stock: z.boolean().optional(),
  image_url: z.string().optional(),
  description: z.string().optional(),
  sort: z.number().int().optional(),
  active: z.boolean().optional(),
  avail_days: z.string().regex(/^[01]{7}$/).optional().nullable(),
  avail_start_min: z.number().int().min(0).max(1440).optional().nullable(),
  avail_end_min: z.number().int().min(0).max(1440).optional().nullable(),
});
export type UpdateItemDto = z.infer<typeof UpdateItemBody>;

export const SetAvailabilityBody = z.object({ available: z.boolean() });

export const OptionBody = z.object({
  name: z.string().min(1),
  price_delta: z.number().default(0),
  is_default: z.boolean().optional(),
  sort: z.number().int().optional(),
});

export const CreateModifierGroupBody = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  min_select: z.number().int().nonnegative().default(0),
  max_select: z.number().int().positive().default(1),
  required: z.boolean().optional(),
  options: z.array(OptionBody).optional(),
});
export type CreateModifierGroupDto = z.infer<typeof CreateModifierGroupBody>;

export const AttachGroupBody = z.object({ group_id: z.number().int() });

export const ResolveLineBody = z.object({
  sku: z.string().optional(),
  item_id: z.number().int().optional(),
  qty: z.number().positive().default(1),
  modifier_option_ids: z.array(z.number().int()).optional(),
  notes: z.string().optional(),
}).refine((b) => b.sku != null || b.item_id != null, { message: 'sku or item_id required' });
export type ResolveLineDto = z.infer<typeof ResolveLineBody>;
