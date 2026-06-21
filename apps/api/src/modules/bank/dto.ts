import { z } from 'zod';

export const CreateBankAccountBody = z.object({
  bank_name: z.string().min(1),
  account_no: z.string().min(1),
  gl_account_code: z.string().default('1010'),
  currency: z.string().default('THB'),
  opening_balance: z.number().default(0),
});
export type CreateBankAccountDto = z.infer<typeof CreateBankAccountBody>;

export const ImportStatementBody = z.object({
  statement_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  opening_bal: z.number().default(0),
  closing_bal: z.number().default(0),
  lines: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    description: z.string().optional(),
    amount: z.number(),            // SIGNED: +in / -out
    balance: z.number().optional(),
  })).min(1),
});
export type ImportStatementDto = z.infer<typeof ImportStatementBody>;

export const ManualMatchBody = z.object({ journal_line_id: z.number().int().positive() });
export const AdjustmentBody = z.object({ kind: z.enum(['fee', 'interest']).default('fee'), memo: z.string().optional() });
export type AdjustmentDto = z.infer<typeof AdjustmentBody>;
