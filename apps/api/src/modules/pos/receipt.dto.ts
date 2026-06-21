import { z } from 'zod';

export const ReceiptFormatQuery = z.enum(['html', 'pdf', 'escpos']).default('html');

export const SendReceiptBody = z.object({
  channel: z.enum(['email', 'sms']),
  to: z.string().min(3),                 // email address or phone
}).refine((b) => b.channel === 'sms' || /.+@.+\..+/.test(b.to), { message: 'email channel requires a valid email address' });
export type SendReceiptDto = z.infer<typeof SendReceiptBody>;
