import { z } from 'zod';

export const CreateIcBody = z.object({
  from_tenant_id: z.number().int().positive(),   // creditor / due-from
  to_tenant_id: z.number().int().positive(),     // debtor / due-to
  amount: z.number().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  currency: z.string().default('THB'),
  category: z.enum(['shared-cost', 'transfer', 'loan']).default('shared-cost'),
  description: z.string().optional(),
}).refine((b) => b.from_tenant_id !== b.to_tenant_id, { message: 'from and to tenants must differ' });
export type CreateIcDto = z.infer<typeof CreateIcBody>;

export const SettleIcBody = z.object({
  amount: z.number().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type SettleIcDto = z.infer<typeof SettleIcBody>;
