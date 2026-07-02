import { z } from 'zod';

// ── Tax invoices (ใบกำกับภาษี) ──
const BuyerBlock = z.object({
  name: z.string().min(1),
  tax_id: z.string().optional(),
  branch_code: z.string().optional(),
  address: z.string().min(1),
});

export const IssueFullBody = z.object({
  source_type: z.enum(['POS', 'AR']),
  source_ref: z.string().min(1),
  buyer: BuyerBlock,
  book_no: z.string().optional(),
  notes: z.string().optional(),
});
export type IssueFullDto = z.infer<typeof IssueFullBody>;

export const IssueAbbreviatedBody = z.object({
  sale_no: z.string().min(1),
});
export type IssueAbbreviatedDto = z.infer<typeof IssueAbbreviatedBody>;

// ── WHT 50 ทวิ (หนังสือรับรองการหักภาษี ณ ที่จ่าย) ──
const WhtLine = z.object({
  income_type: z.string().min(1),         // '40(2)'|'40(5)'|'3tre-service'|... (see wht-rates.ts)
  description: z.string().optional(),
  date_paid: z.string().optional(),
  amount_paid: z.number().positive(),     // ฐานภาษี (ไม่รวม VAT)
  rate: z.number().positive().max(0.3).optional(), // ถ้าไม่ส่ง ใช้อัตรามาตรฐานของ income type
});

export const IssueWhtBody = z.object({
  pnd_type: z.enum(['PND1K', 'PND1KS', 'PND2', 'PND2K', 'PND3', 'PND3K', 'PND53']).optional(), // ถ้าไม่ส่ง derive
  date_paid: z.string().min(1),
  payee: z.object({
    name: z.string().min(1),
    tax_id: z.string().min(1),
    branch_code: z.string().optional(),
    address: z.string().optional(),
    kind: z.enum(['person', 'company']),
  }),
  ap_txn_no: z.string().optional(),
  payment_no: z.string().optional(),
  condition: z.enum(['withhold', 'absorb_always', 'absorb_once', 'other']).optional(),
  condition_other: z.string().optional(),
  signer_name: z.string().optional(),
  book_no: z.string().optional(),
  run_no: z.string().optional(),
  is_replacement: z.boolean().optional(),
  lines: z.array(WhtLine).min(1),
});
export type IssueWhtDto = z.infer<typeof IssueWhtBody>;
