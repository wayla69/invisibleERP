import { z } from 'zod';

const ItemInput = z.object({
  item_id: z.string().optional(),
  name: z.string().min(1),
  qty: z.number().positive().default(1),
  unit_price: z.number().nonnegative(),
  station_code: z.string().optional(),       // resolve to a kitchen station; else default
  modifiers: z.array(z.object({ label: z.string() })).optional(),
  notes: z.string().optional(),
  est_prep_minutes: z.number().int().positive().optional(),
});

export const CreateOrderBody = z.object({
  table_id: z.number().int().optional(),
  session_id: z.number().int().optional(),
  guest_count: z.number().int().positive().optional(),
  notes: z.string().optional(),
  items: z.array(ItemInput).min(1),
});
export type CreateOrderDto = z.infer<typeof CreateOrderBody>;

export const AddItemsBody = z.object({ items: z.array(ItemInput).min(1) });
export type AddItemsDto = z.infer<typeof AddItemsBody>;

export const KdsActionBody = z.object({ action: z.enum(['start', 'ready', 'recall', 'serve', 'void']), reason: z.string().optional() });
export type KdsActionDto = z.infer<typeof KdsActionBody>;

export const CheckoutBody = z.object({ method: z.string().optional(), discount: z.number().nonnegative().optional() });
export type CheckoutDto = z.infer<typeof CheckoutBody>;

// ── tables / floor-plan ──
export const CreateTableBody = z.object({
  table_no: z.string().min(1), zone_id: z.number().int().optional(), seats: z.number().int().positive().optional(),
  shape: z.string().optional(), pos_x: z.number().optional(), pos_y: z.number().optional(),
  width: z.number().optional(), height: z.number().optional(),
});
export type CreateTableDto = z.infer<typeof CreateTableBody>;

export const UpdateTableBody = CreateTableBody.partial();
export type UpdateTableDto = z.infer<typeof UpdateTableBody>;

export const TableStatusBody = z.object({ status: z.enum(['available', 'reserved', 'occupied', 'bill_requested', 'paying', 'cleaning', 'out_of_service']) });

export const ZoneBody = z.object({ name: z.string().min(1), sort_order: z.number().int().optional() });

export const StationBody = z.object({ code: z.string().min(1), name: z.string().min(1), sort: z.number().int().optional(), default_prep_minutes: z.number().int().positive().optional() });
