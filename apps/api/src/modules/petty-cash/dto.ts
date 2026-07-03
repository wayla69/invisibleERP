import { z } from 'zod';

export const EstablishFundBody = z.object({
  fund_code: z.string().min(1),
  name: z.string().optional(),
  custodian: z.string().optional(),
  department: z.string().optional(),
  gl_account: z.string().optional(),
  float_limit: z.number().positive(),         // วงเงิน — imprest ceiling
  initial_amount: z.number().nonnegative().optional(), // cash placed into the fund at establishment
});
export type EstablishFundDto = z.infer<typeof EstablishFundBody>;

export const ReplenishBody = z.object({ amount: z.number().positive() });
export type ReplenishDto = z.infer<typeof ReplenishBody>;

export const ExpenseRequestBody = z.object({
  fund_code: z.string().min(1),
  kind: z.enum(['expense', 'advance']),
  payee: z.string().optional(),
  purpose: z.string().optional(),
  amount: z.number().positive(),
  expense_account: z.string().optional(),
  doc_ref: z.string().optional(),
  receipt_key: z.string().optional(),
  project_code: z.string().optional(), // M4 (docs/32) — petty-cash spend against a project
});
export type ExpenseRequestDto = z.infer<typeof ExpenseRequestBody>;

export const SettleExpenseBody = z.object({
  settled_expense: z.number().nonnegative(),
  returned_cash: z.number().nonnegative().optional(),
  expense_account: z.string().optional(),
});
export type SettleExpenseDto = z.infer<typeof SettleExpenseBody>;

export const RejectBody = z.object({ reason: z.string().optional() });
