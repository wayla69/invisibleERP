import { z } from 'zod';

export const ReturnItemBody = z.object({
  sale_item_id: z.number().optional(),
  item_id: z.string().optional(),
  qty: z.number().positive(),
}).refine((b) => b.sale_item_id != null || b.item_id != null, { message: 'sale_item_id or item_id required' });

export const CreateReturnBody = z.object({
  sale_no: z.string().min(1),
  items: z.array(ReturnItemBody).min(1),
  reason: z.string().optional(),
  refund_method: z.enum(['Cash', 'Card', 'QR', 'PromptPay', 'StoreCredit', 'None']).optional(),
  gift_card_no: z.string().optional(), // StoreCredit: top up this card; omit to mint a new one
});

export type CreateReturnDto = z.infer<typeof CreateReturnBody>;
