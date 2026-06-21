import { z } from 'zod';

// ── MULTI-TENDER: one bill paid by several methods/people ──
const TenderInput = z.object({
  method: z.string().min(1),                 // Cash | PromptPay | Card | Transfer | Wallet
  amount: z.number().positive(),
  gateway: z.string().optional(),
});
export const MultiTenderBody = z.object({
  discount: z.number().nonnegative().optional(),
  tenders: z.array(TenderInput).min(1),
});
export type MultiTenderDto = z.infer<typeof MultiTenderBody>;

// ── SPLIT BILL ──
const ItemAssign = z.object({
  item_id: z.number().int(),                 // dine_in_order_items.id
  check: z.number().int().positive(),
});
export const SplitPreviewBody = z.object({
  method: z.enum(['equal', 'by_items']),
  ways: z.number().int().min(2).optional(),
  assignments: z.array(ItemAssign).optional(),
  discount: z.number().nonnegative().optional(),
}).refine((b) => b.method !== 'equal' || (b.ways ?? 0) >= 2, { message: 'equal split needs ways>=2' })
  .refine((b) => b.method !== 'by_items' || (b.assignments?.length ?? 0) > 0, { message: 'by_items needs assignments' });
export type SplitPreviewDto = z.infer<typeof SplitPreviewBody>;

const CheckTender = z.object({ check: z.number().int().positive(), method: z.string().min(1), gateway: z.string().optional() });
export const SplitSettleBody = SplitPreviewBody.and(z.object({ tenders: z.array(CheckTender).optional() }));
export type SplitSettleDto = z.infer<typeof SplitSettleBody>;
