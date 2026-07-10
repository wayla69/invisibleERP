import { z } from 'zod';

export const ReceiptFormatQuery = z.enum(['html', 'pdf', 'escpos']).default('html');

// POS-2: channel 'line' pushes a flex e-receipt to the LINE account of the loyalty member on the sale —
// no `to` needed (and any provided value is ignored); email/sms still require an explicit recipient.
export const SendReceiptBody = z.object({
  channel: z.enum(['email', 'sms', 'line']),
  to: z.string().min(3).optional(),      // email address or phone; omitted for 'line'
})
  .refine((b) => b.channel === 'line' || !!b.to, { message: 'email/sms channel requires a recipient' })
  .refine((b) => b.channel !== 'email' || /.+@.+\..+/.test(b.to ?? ''), { message: 'email channel requires a valid email address' });
export type SendReceiptDto = z.infer<typeof SendReceiptBody>;
