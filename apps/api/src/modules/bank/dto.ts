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

// File import: the bank's own CSV text or base64 XLSX; explicit opening/closing/date override the
// values derived from the file's running-balance column. auto_match runs the matcher right after import.
export const ImportStatementFileBody = z.object({
  csv: z.string().optional(),
  xlsx: z.string().optional(), // base64
  statement_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  opening_bal: z.number().optional(),
  closing_bal: z.number().optional(),
  auto_match: z.boolean().default(false),
}).refine((b) => !!b.csv || !!b.xlsx, { message: 'csv or xlsx required' });
export type ImportStatementFileDto = z.infer<typeof ImportStatementFileBody>;

export const ManualMatchBody = z.object({ journal_line_id: z.number().int().positive() });
export const AdjustmentBody = z.object({ kind: z.enum(['fee', 'interest']).default('fee'), memo: z.string().optional() });
export type AdjustmentDto = z.infer<typeof AdjustmentBody>;
