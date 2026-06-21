import { z } from 'zod';

export const IssueGiftCardBody = z.object({
  amount: z.number().positive(),
  method: z.string().min(1).default('Cash'),   // how the card was paid for (Cash/Card/QR)
  till_session_id: z.number().int().optional(),
  note: z.string().optional(),
});
export type IssueGiftCardDto = z.infer<typeof IssueGiftCardBody>;

export const RedeemGiftCardBody = z.object({
  card_no: z.string().min(1),
  sale_no: z.string().min(1),
  amount: z.number().positive(),
});
export type RedeemGiftCardDto = z.infer<typeof RedeemGiftCardBody>;
